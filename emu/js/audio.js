// Copyright (c) 2013, Jim Battle
// All rights reserved.
// 
// Redistribution and use in source and binary forms, with or without modification,
// are permitted provided that the following conditions are met:
// 
//   Redistributions of source code must retain the above copyright notice, this
//   list of conditions and the following disclaimer.
// 
//   Redistributions in binary form must reproduce the above copyright notice, this
//   list of conditions and the following disclaimer in the documentation and/or
//   other materials provided with the distribution.
// 
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
// ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
// ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

//============================================================================
// SoundWare emulation
//============================================================================
// Ths module emulates the behavior of the Soundware add on hardware for
// the Compucolor computer.  The hardware was very simple: an RC filter
// hanging on the serial port TXD pin, driving a small amplifier and spaker
// (apparently a modified transistor radio).  In normal circumstances, the
// TXD pin is toggled via messing with the 5501 discrete command register
// to force/release the line break state.

// option flags for jslint:
/* global alert, ccemu, AudioContext */

// Constructor
var audio = (function () {

    'use strict';

    // ---------- device invariants:

    // cpu frequency dependent parameters, set during reset()
    var CPU_FREQ = 1;  // var CPU_FREQ = 1996800;

    // ---------- private variables:

    // this is the time stamp of the last time the TXD pin changed
    var lastTxdState = 0;
    var lastTxdEvent = 0;

    // this is used to track exactly when to push out a new sample.
    // it counts up from 0, modulo CPU_FREQ.
    var audioSamplePhase = 0;
    var audioSampleVal = 0.0;
    var audioSampleValx = 0.0;
    var maxDelta = 1;

    // is soundware emulation enabled?
    var soundwareEnabled = 0;
    // precompute exponential decay constants for various tick intervals
    // 256 is somewhat magic; it has to be large enough to compute how
    // much decay occurs over one sample (CPU_FREQ / AUDIO_FREQ), or
    // normally ~2M/44100 = 46.
    var decayTableSize = 256;
    var decay = new Array(256);

    // audio api state
    // NB: as of 11/25/2013, one doesn't get to pick a sample rate for the
    //     audiocontext -- it is a read-only property
    // NB: 1024 seems fine on firefox 25 running natively on my machine,
    //     and it does just as well running on windows XP under vmware
    //     on that same machine.  Running on Chrome 30.something under
    //     vmware sounds horrible, while 2048 is OK.  This comes at the
    //     expensive or making noticeably bad lag even worse.
    var audio_BLOCK_SAMPLES = 2048;  // # samples per audio_processor callback
    var audio_context;
    var audio_processor;
    var AUDIO_FREQ = 1;

    // a place to accumulate samples before they get pushed out
    var audio_sample_buffer_size = audio_BLOCK_SAMPLES*4;
    var audio_sample_buffer = 0;
    var audio_sample_buffer_put = 0;
    var audio_sample_buffer_get = 0;
    var audio_sample_buffer_count = 0;
    var audio_sample_buffer_did_underrun = 0;

    var destroy_ac = 0;  // 1=break down audio_context when audio is disabled
    var soundware_status = $('#soundware_debug');
    var audio_debug = 0;

    // ---------- private methods

    function reset() {
        CPU_FREQ = ccemu.getCpuFreq();
    }

    // true to enable soundware emulation; false to disable it
    function enable(value) {
        if (value && !audio_context) {  // enabling it

            // the 3db point of a simple RC filter is 1/(2*pi*R*C),
            // which in this case is ~4000 Hz.
            // FIXME: what RC values did Soundware use?
            var R = 1000;     // RC filter constant (ohms)
            var C = 0.4e-7;   // RC filter constant (farads)
            var exp_K = (-1.0 / (CPU_FREQ * R * C));
            for (var t = 0; t < decayTableSize; t++) {
                decay[t] = 1.0 - Math.exp(t * exp_K);
            }

            // limit how many samples we generate when we try to catch up
            maxDelta = 500 * CPU_FREQ / AUDIO_FREQ;

            // set up audiocontext
            audio_context = new AudioContext();
            AUDIO_FREQ = audio_context.sampleRate;
            audio_sample_buffer = new Float32Array(audio_sample_buffer_size);

            audio_processor = audio_context.createScriptProcessor(audio_BLOCK_SAMPLES, 0, 1);
            audio_processor.connect(audio_context.destination);
            audio_processor.onaudioprocess = produce_audio;

            audio_sample_buffer_put = 0;
            audio_sample_buffer_get = 0;
            audio_sample_buffer_count = 0;
            audio_sample_buffer_did_underrun = 0;

            // start tracking time now
            lastTxdEvent = ccemu.getTickCount();

        } else if (!value && soundwareEnabled) {

            // FIXME: as far as I can tell, there is no way to start/stop
            //        an output-only stream.  so, instead, I break down the
            //        audiocontext.  it works, except if I reenable audio,
            //        it produces noise.
            if (destroy_ac) {
                audio_processor.onaudioprocess = 0;
                audio_processor = 0;
                audio_context = 0;
            }
        }

        soundwareEnabled = value;
    }

    // this is called when the 5501 toggles the break state
    // 1=force space, 0=send mark or txdata
    function breakEvent(value) {
        if (value === lastTxdState) {
            // nothing has happened
            return;
        }
        advanceTime();
        if (soundwareEnabled) {
            lastTxdState = value;
        } // else retain the old value == silence
    }

    // generate samples corresponding to the time interval from the
    // last time we produced a sample until now.
    function advanceTime() {
        if (!audio_context) {
            return;
        }

        var driver = (lastTxdState) ? 1.0 : 0.0;
        var now = ccemu.getTickCount();
        var delta = now - lastTxdEvent;

        // if there has been no audio activity for a long time,
        // limit how many samples we produce.
        if (delta > maxDelta) {
            delta = maxDelta;
        }

        // we produce one audio sample every CPU_FREQ / AUDIO_FREQ ticks.
        // to keep things precise and avoid roundoff errors, we use a DDA
        // to decide when to produce an audio sample.
        while (delta > 0) {
            // compute the next sample point
            var n1 = Math.floor((CPU_FREQ-1 - audioSamplePhase) / AUDIO_FREQ + 1);
            var ticks = (n1 < delta) ? n1 : delta;
            audioSamplePhase += ticks * AUDIO_FREQ;
            delta -= ticks;

            if (isNaN(audioSampleVal)) {
                audioSampleVal = 0.0;
            }
            //audioSampleVal += (driver - audioSampleVal) * decay[ticks];
            audioSampleValx = audioSampleVal + (driver - audioSampleVal) * decay[ticks];
            if (isNaN(audioSampleValx)) {
                audioSampleValx = 0.0;
            }
            audioSampleVal = audioSampleValx;

            // either we generate an audio sample or we're done
            if (audioSamplePhase >= CPU_FREQ) {
                audioSamplePhase -= CPU_FREQ;
                // generate new audio sample
                push_audio_sample(audioSampleVal);
            }
        }

        lastTxdEvent = now;
    }

    function push_audio_sample(value) {
        if (audio_sample_buffer_count < audio_sample_buffer_size) {
            // normalize the 0.0 to 1.0 to instead range -0.25 to +0.25
            audio_sample_buffer[audio_sample_buffer_put] = 0.5 * value - 0.25;
            audio_sample_buffer_put++;
            if (audio_sample_buffer_put >= audio_sample_buffer_size) {
                audio_sample_buffer_put = 0;
            }
            audio_sample_buffer_count++;
        }
    }

    // this is called when the 5501 is given a new byte to transmit
    var alert_again = 1;
    function txData(value) {
        if (!audio_context) {
            return;
        }

        // the standard soundware patch only toggles TXD via the break bit.
        // if we need to model this, we will also need to know the port speed.
        // TODO: is this important to model?
        if (audio_debug && audio_context && alert_again) {
            alert("this app is doinking the serial port for audio");
            alert_again = 0;
        }
        value = value; // make lint happy
        return;
    }

    // audio process timed callback.
    // produce the next block of samples to the speaker.
    var sample_counts = new Array(20);
    var sample_counts_ptr = 0;
    function produce_audio(e) {
        var i, tot, boost_factor;

        // generate samples in case there has been no recent event
        advanceTime();

        var output = e.outputBuffer.getChannelData(0);
        if (audio_sample_buffer_count < audio_BLOCK_SAMPLES) {

            // make a gap -- retain previous value to reduce glitch
            var nextsamp = audio_sample_buffer[audio_sample_buffer_get];
            audio_sample_buffer_did_underrun = 1;
            for(i=0; i < audio_BLOCK_SAMPLES; i++) {
                output[i] = nextsamp;
            }
            if (audio_debug) {
                soundware_status.html('<span style="background-color:#f00">!!!BARF!!!</span>');
            }

        } else {

            // send the next block of samples
            for(i=0; i < audio_BLOCK_SAMPLES; i++) {
                output[i] = audio_sample_buffer[audio_sample_buffer_get];
                audio_sample_buffer_get++;
                if (audio_sample_buffer_get >= audio_sample_buffer_size) {
                    audio_sample_buffer_get = 0;
                }
            }
            audio_sample_buffer_count -= audio_BLOCK_SAMPLES;

            // if we accumulate too many samples, the audio will get laggy.
            // throttle down cpu down a few percent until we are safe again.
            // if we have too few samples, we are in danger of underrunning,
            // so we boost the cpu up a few percent until we are safe again.
            if (audio_sample_buffer_count < 0.75*audio_BLOCK_SAMPLES) {
                boost_factor = 1;
            } else if (audio_sample_buffer_count > 1.0*audio_BLOCK_SAMPLES) {
                boost_factor = -1;
            } else {
                boost_factor = 0;
            }
            ccemu.audioBoostCpu(boost_factor);

            if (audio_debug) {
                sample_counts[sample_counts_ptr] = audio_sample_buffer_count;
                sample_counts_ptr = (sample_counts_ptr + 1) % 20;
                tot = 0;
                for(i=0; i<20; i++) { tot += sample_counts[i]; }
                //soundware_status.html("boost=" + boost_factor + ", count=" + Math.floor(tot/20.0));
                soundware_status.html("count=" + Math.floor(tot/20.0));
            }
        }

    } // produce_audio

    // ---------- expose public methods
    return {
        'constructor'      : Audio,
        'reset'            : reset,
        'enable'           : enable,
        'breakEvent'       : breakEvent,
        'txData'           : txData
    };

}());  // audio

audio = audio; // keep jshint happy

// vim:et:sw=4:
