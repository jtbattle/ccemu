// Copyright (c) 2013-2014, Jim Battle
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
// autotyper
//============================================================================
// a utility to send a stream of text lines to the emulated keyboard

// option flags for jslint:
/* global console, alert, confirm */
/* global Cpu, crt, tms5501, smc5027, keybrd, floppy, autotyper */
/* global system_rom, uf6_rom, crt_timing_rom */

var autotyper = (function () {

    'use strict';

    // set to true if the auto typer should simulate one keypress at a time.
    // otherwise, it will stuff a line at a time, which is much faster.
    var key_at_a_time = false;

    // state
    var text = '',    // the text we are streaming
        offset = -1,  // next char ptr (<0 means not running)
        phase = 0;

    // supply text to send
    // returns true on success, false if it failure
    function start(txt) {
        var reply;

        // sanity check the file size
        if (txt.length === 0) {
            alert('That is an empty file!');
            return false;
        }

        // sanity check the file size
        if (txt.length > 32*1024) {
            reply = confirm('The file is ' + txt.length + ' bytes long.\n' +
                            'Hit "OK" if you still want to proceed.');
            if (!reply) {
                return false;
            }
        }

        // sanity check the line ending convention
        function countRe(txt, re) {
            var pieces = txt.match(re);
            if (pieces === null) {
                return 0;
            }
            return pieces.length;
        }

        var crs   = countRe(txt, /\r/g);   // compucolor & mac line endings
        var nls   = countRe(txt, /\n/g);   // unix line endings
        var crnls = countRe(txt, /\r\n/g); // dos line endings
        var re, pieces;
        if (crnls*1.1 >= crs && crnls*1.1 >= nls) {
            // the *1.1 is because the number of crs and the number of
            // newlines is at least as great as the number of cr/nls, so
            // any stray cr's or nl's would confuse things.
            reply = confirm('The file appears to use DOS line endings.\n' +
                            'Hit "OK" to convert them to Mac line endings ' +
                            'on the fly, "Cancel" to prevent the conversion.');
            if (reply) {
                re = /\r\n/g;
            }
        } else if (nls > crs) {
            // apparently unix line endings
            reply = confirm('The file appears to use Unix line endings.\n' +
                            'Hit "OK" to convert them to Mac line endings ' +
                            'on the fly, "Cancel" to prevent the conversion.');
            if (reply) {
                re = /\n/g;
            }
        } else {
            // apparently compucolor/Mac line endings
            re = /\r/g;
        }
        pieces = txt.split(re);
        var len = pieces.length;

        // check for long lines
        var longlinesOk = false;
        for (var n=0; n < len && !longlinesOk; n++) {
            if (pieces[n].length > 97) {
                reply = confirm(
                        'Warning: some lines are greater than the maximum ' +
                        'line buffer size (97).\n' +
                        'For example, line ' + (n+1) + ' is ' +
                         pieces[n].length + ' bytes long.\n' +
                        'Hit "OK" to proceed, resulting in truncated lines, ' +
                        'or "Cancel" to abort the transfer.');
                if (!reply) {
                    return false;
                } else {
                    longlinesOk = true;
                }
            }
        }

        // OK, accept it for processing
        text = pieces.join('\r');
        offset = 0;
        phase = 0;   // needed only for keyStuff routine
        return true;
    }

    // stop any action if it is running
    function cancel() {
        offset = -1;
        phase = 0;
    }

    // this is the next character to send (string or ascii code)
    function nextChar() {
        return text.charAt(offset);
    }
    function nextCharCode() {
        return text.charCodeAt(offset);
    }

    // true if we are busy sending stuff
    function isRunning() {
        return (offset >= 0);
    }

    // if the first line contains "[[[RESET]]]", it isn't sent to the device,
    // but instead a system reset is done
    function isMagicReset() {
        return (offset === 0) &&
               (text.slice(0,11) === "[[[RESET]]]");
    }

    // trick the keyboard polling routine to accept one key at a time
    function pollKeyStuff() {
        var thrufl = 0x81de;  // line input done flag

        // FIXME: this code is common to pollLineStuff
        if (isRunning() && isMagicReset()) {
            ccemu.hardReset(true);
            text = '\r' +           // the first line after reset gets eaten
                   text.slice(11);  // chomp
            if (text.length === 0) {
                offset = -1; // done
            }
            return;
        }

        if (isRunning()) {
            var ch = nextChar();
            if (phase < 0) {
                phase++;
            } else if ((phase === 0) &&
                       (ccemu.rd(thrufl) === 0)) { // buffer accepting input
                keybrd.asciiKey(ch); // set it
                phase = 1;
            } else if (phase === 1) {
                keybrd.asciiKey(); // clear it
                // heuristic: delay to allow for line processing
                phase = (ch === '\r') ? -10 : 0;
                offset++;
                if (offset >= text.length) {
                    phase = 0;
                    offset = -1;  // signal that we are done
                }
            }
        }
    }

    // stuff a line at a time into the LINBF buffer
    function pollLineStuff() {

        var bufsz  = 97,      // maximum line length
            bufptr = 0x8046,  // start at LINBF
            thrufl = 0x81de,  // line input done flag
            len = 0;

        if (isRunning() && isMagicReset()) {
            ccemu.hardReset(true);
            text = '\r' +           // the first line after reset gets eaten
                   text.slice(11);  // chomp
            if (text.length === 0) {
                offset = -1; // done
            }
            return;
        }

        if (isRunning() &&
            (ccemu.rd(thrufl) === 0)) { // buffer is in accepting state
            // leading zero
            ccemu.wr(bufptr, 0x00);
            // stuff until we run out message, or hit a carriage return,
            // or the buffer size limit
            while ((len < bufsz) &&
                    (offset < text.length) &&
                    (nextCharCode() !== 0x0D)
                  ) {
                ccemu.wr(bufptr + 1 + len, nextCharCode());
                offset++;  // skip carriage returns between lines
                len++;
            }
            // trailing zero
            ccemu.wr(bufptr + 1 + len, 0x00);
            // set THRUFL to indicate the line is complete
            ccemu.wr(thrufl, 0x0D);
            // check why we ended
            if ((len === bufsz) &&
                 (offset < text.length) &&
                 (nextCharCode() !== 0x0D)) {
                alert('Input line was too long and got split\r\n' +
                      '(max length is ' + bufsz + ' characters)');
            }
            if (nextCharCode() === 0x0D) {
                offset++;  // skip carriage returns between lines
            }
            if (offset === text.length) {
                offset = -1;  // signal that we are done
            }
        }
    }

    function percentDone() {
        if (isRunning()) {
            return (100 * offset / text.length);
        }
        return 0;
    }

    // this needs to be called periodically to check if the
    // keyboard input routine is ready for more
    var poll = (key_at_a_time) ? pollKeyStuff :
                                 pollLineStuff;

    // expose public members:
    return {
        'start':        start,
        'poll':         poll,
        'cancel':       cancel,
        'isRunning':    isRunning,
        'percentDone':  percentDone
    };

}());  // autotyper

// vim:et:sw=4:
