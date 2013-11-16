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
// Floppy disk
//============================================================================
// module structure taken from this website:
//   http://webreflection.blogspot.com/2008/04/natural-javascript-private-methods.html

// option flags for jslint:
/* global console, alert */
/* global ccemu, tms5501, scheduler */

// TODO:
//   this assumes 1 stop bit -- it really depends on the 5501 rate register
//   this doesn't respond to the 5501 line break control bit

var floppy_dbg = 0;  // debug hack

// Constructor
function Floppy(unit_num) {

    'use strict';

    var unit = unit_num;   // eg: '0'
    var devName = 'CD' + unit + ':';  // eg: 'CD0:'

    // --- device invariants:

    // each track is represented by 1920 bytes = 15360 bit times per track
    // which is 76800 baud * 200 ms worth of data.
    var bitsPerTrack = 76800 / 5;

    // cpu frequency dependent parameters, set during reset()
    var CPU_FREQ = 0;
    var tickToBitScale = 0;  // convert 8080 ticks to floppy bit periods
    var bitToTickScale = 0;  // convert floppy bit periods to 8080 ticks

    // properties of the currently inserted disk:
    var diskImage;                // holds array of array of bits packed into bytes
    var writeProtected = false;   // floppy write protect status
    var label;                    // list of label lines

    // properties of the disk drive or controller
    var curSelected = 0;  // 1 if we are currently selected
    var curStepper = 0;   // stepper motor phase
    var curWrite = 0;     // write control
    var physTrack = 0;    // track we are on
    var curPosition = 0;  // rotational position, in bits
    var writeStart = 0;   // time of most recent write-related event

    // emulation timers to schedule events in the 8080 future
    // TODO: these three are disjoint -- at most one is active at a time
    var motorTimer;      // times out a while after drive is deselected
    var readByteTimer;   // schedules delivery of next byte off floppy
    var writeByteTimer;  // schedules noticed to 5501 that last byte is done

    // ---------- private methods

    function reset() {
        CPU_FREQ = ccemu.getCpuFreq();
        tickToBitScale = 76800 / CPU_FREQ;
        bitToTickScale = CPU_FREQ / 76800;
        physTrack = 0;
        curPosition = 0;
        if (motorTimer) {
            if (floppy_dbg) {
                console.log(devName + ' resetting');
            }
            motorTimer.cancel();
            motorTimer = undefined;
        }
        cancelReadByte();
        curPosition = 0; // a small lie, but let's keep things simple
    }

    // write one bit to current position on the track
    // not efficient, but foolproof
    function writeBit(bitval) {
        var bytePtr = (curPosition >> 3);
        var bitPtr  = (curPosition & 7);

        if (bitval) {
            diskImage[physTrack][bytePtr] |= (0x01 << bitPtr);
        } else {
            diskImage[physTrack][bytePtr] &= ~(0x01 << bitPtr);
        }
        curPosition++;
        if (curPosition >= bitsPerTrack) {
            curPosition = 0;
        }
    }

    function peekBit(off) {
        var posOff = curPosition + off;
        if (posOff < 0) {
            posOff += bitsPerTrack;
        } else if (posOff >= bitsPerTrack) {
            posOff -= bitsPerTrack;
        }
        var bytePtr = (posOff >> 3);
        var bitPtr  = (posOff & 7);
        var byteval = diskImage[physTrack][bytePtr];
        return (byteval >> bitPtr) & 1;
    }

    function findStartBit() {
        var prev = peekBit(-1);
        for (var n = 0; n < bitsPerTrack; n++) {
            var pb = peekBit(n);
            if (prev && !pb) {
                return n;
            }
            prev = pb;
        }
        // couldn't find a start bit!
        return undefined;
    }

    // look ahead to the next start bit.  then schedule an event 10 bits
    // in time after that to report the byte which just passed.
    // that event will then report that byte and status to the 5501,
    // and repeat the process.
    function scheduleReadByte() {
        if (curWrite || (diskImage === undefined)) {
            return;
        }
        var off = findStartBit();
        if (off === undefined) {
            // we can't find one, so don't set up a timer
            if (floppy_dbg) {
                console.log(devName + ' scheduleReadByte couldn\'t find start bit; killing timer');
            }
            return;
        }
        var delta = off + 10;  // number of bits until end of next byte
        var ticks = Math.floor(delta * bitToTickScale);
        if (0 && floppy_dbg) {
            console.log('T' + ccemu.getTickCount() + '::' + devName +
                        ' scheduling a read ' + ticks + ' ticks from now');
        }
        readByteTimer = scheduler.oneShot(ticks, readByteCallback,
                                          devName + "readByte");
        // advance to the next start bit
        curPosition += off;
        if (curPosition >= bitsPerTrack) {
            curPosition -= bitsPerTrack;
        }
    }

    // enough time has elapsed that we should advance to the end of the
    // next byte and report the one which just went past
    function readByteCallback() {
        var startBit = peekBit(0);
        assert(startBit === 0, 'readByteCallback didn\'t find a start bit!');
        var byteVal = (peekBit(1) << 0) |
                      (peekBit(2) << 1) |
                      (peekBit(3) << 2) |
                      (peekBit(4) << 3) |
                      (peekBit(5) << 4) |
                      (peekBit(6) << 5) |
                      (peekBit(7) << 6) |
                      (peekBit(8) << 7);
        var framingError = !peekBit(9);  // stop bit should be 1

        curPosition += 10;
        if (curPosition >= bitsPerTrack) {
            curPosition -= bitsPerTrack;
        }

        tms5501.rxSerial(byteVal, framingError);
        readByteTimer = undefined;
        if (0 && floppy_dbg) {
            console.log('T' + ccemu.getTickCount() + ':: ' + devName +
                        ' offset=' + curPosition +
                        ' got byte ' + byteVal.toString(16) +
                        ' framing=' + framingError);
        }
        scheduleReadByte();
    }

    function cancelReadByte() {
        if (readByteTimer !== undefined) {
            if (floppy_dbg) {
                console.log(devName + ' canceling scheduleReadByte id=' + readByteTimer.id);
            }
            // the disk might have advanced a few bits
            var elapsed = readByteTimer.age();
            advancePositionNTicks(elapsed);
            readByteTimer.cancel();
            readByteTimer = undefined;
        }
    }

    function advancePositionNTicks(ticks) {
        curPosition += Math.floor(ticks * tickToBitScale);
        curPosition = curPosition % bitsPerTrack;
    }

    function cancelMotorTimer() {
        if (motorTimer) {
            if (floppy_dbg) {
                console.log(devName + ' canceling motorTimer id=' + motorTimer.id);
            }
            var elapsed = motorTimer.age();
            motorTimer.cancel();
            motorTimer = undefined;
            advancePositionNTicks(elapsed);
        }
    }

    // produce response to 5501 parallel port read of the drive status
    function getStatus() {
        return 0x00;  // the floppy doesn't return any status
    }

    // rather than attempting to update the write stream as each bit cell
    // passes the write head, we note the current 8080 tick count (as
    // writeStart) at certain events.  Later, when another event happens,
    // we write a stream of bits corresponding from writeStart to the
    // current time.
    function updateWriteStream() {
        if (diskImage === undefined) {
            return;
        }

        if (curWrite) {
            var now = ccemu.getTickCount();
            var delta = now - writeStart;
            if (delta < -10) {
                // got called before the previous byte finished
                // (10 ticks are allowed for slop in the scheduler)
                // FMTCD1.PRG (a 3rd party formatter) triggers this because
                // write is enable up to the very cycle where it simultaneously
                // turns off write and steps the motor phase, right after having
                // posted a byte write.
                if (0 && floppy_dbg) {
                    console.log('updateWriteStream has a negative delta of ' + delta);
                }
                // fall through and let the write happen anyway
            }

            var bits = Math.floor(delta * tickToBitScale);
            // if this function gets called very frequently, we might progress
            // progress slowly, or not at all, because of truncation by the
            // floor().  If bits == 0, then we leave writeStart alone so we
            // can see an accumulation of 8080 ticks on a following call.
            if (bits > 0) {
                if (floppy_dbg) {
                    console.log('T' + ccemu.getTickCount() + '::' + devName +
                                ' writing stream of ' + bits + ' bits');
                }
                for (var n = 0; n < bits; n++) {
                    writeBit(1);    // FIXME: what if break status is set?
                }
                if (0) {
                    // more accurate, but worth the complexity?
                    writeStart += Math.floor(bits * bitToTickScale + 0.5);
                } else {
                    writeStart = now;
                }
            }
        }
    }

    // this is called when the 5501 is given a new byte to transmit
    function txData(value) {
        if (diskImage === undefined) {
            return;
        }
        updateWriteStream();
        if (floppy_dbg) {
            console.log('T' + ccemu.getTickCount() + '::' + devName +
                        ' offset=' + curPosition +
                        ' writing ' + value.toString(16));
        }
        writeBit(0);  // start bit
        for (var n = 0; n < 8; n++) {
            writeBit((value >> n) & 1);
        }
        writeBit(1);  // stop bit -- FIXME: 5501 can be programmed for 2 stops
        var ticks = Math.floor(10 * bitToTickScale);
        writeStart = ccemu.getTickCount() + ticks;
        writeByteTimer = scheduler.oneShot(ticks, writeByteCallback,
                                           devName + "writeByte");
    }

    // called after the 10 bits of a write byte have completed
    function writeByteCallback() {
        var now = ccemu.getTickCount();
        // the callback is affected by the scheduler granularity, which is tied to
        // the maximum length 8080 instruction, which is the driving event.
        var delta = Math.abs(writeStart - now);
        assert(delta < 20, 'Error: writeByteCallback was not called on time');
        if (0 && floppy_dbg) {
            console.log('T' + now + '::' + devName +
                        ' notifying 5501 that txdata is sent');
        }
        writeByteTimer = undefined;
        // let the 5501 know the byte is sent so it can mark the tx buffer is empty.
        // because it is double buffered, it might immediately turn around and call txData().
        tms5501.txSerialReady();
    }

    function removeFloppy() {
        updateWriteStream();
        cancelReadByte();
        cancelMotorTimer();
        diskImage = undefined;

        // UI updates
        $('#CD' + unit + 'Label').html('--empty--');
    }

    // return an array of lines of text representing the virtual disk image
    function getFile() {
        var lines = [];
        lines.push('Compucolor Virtual Floppy Disk Image');
        if (writeProtected) {
            lines.push('Write Protect');
        }
        for (var n = 0; n < label.length; n++) {
            lines.push('Label ' + label[n]);
        }
        for (var trk = 0; trk < 41; trk++) {
            lines.push('Track ' + trk);
            for(var group = 0; group < 15360/8; group += 32) {
                var hex = '';
                for(var off = 0; off < 32; off++) {
                    var byt = diskImage[trk][group+off];
                    var ashex = (byt + 0x100).toString(16);
                    hex += ashex.substr(1,2);
                }
                lines.push(hex.toUpperCase());
            }
        }
        return lines;
    }

    // called whenever the 5501 OUT port is written, notifying us if
    // this unit has been selected or not, as well as the !read/write
    // control, and the track stepper motor phase information.
    // NOTE: it is possible for any combination of inputs to change
    //       state simultaneously.
    function select(selected, write, stepper) {

        if (selected) {

            if (!curSelected) {
                $('#CD' + unit).css('background-color' , '#f00');
                if (floppy_dbg) {
                    console.log(devName + ' selected');
                }
                // if we have been deselected for a bit but the motor is
                // still spinning, update the rotational position
                cancelMotorTimer();
                curSelected = 1;
            }

            // at least one program (FMTCD1) doesn't drive any phase windings
            // between steps.  to model this behavior, we just use the current
            // mechanical phase if there is no driving phase.
            var effectivePhase = (stepper === 4) ? 4
                               : (stepper === 2) ? 2
                               : (stepper === 1) ? 1
                                                 : curStepper;

            // update track if stepper phase changed
            if ( (curStepper === 1 && effectivePhase === 4) ||
                 (curStepper === 2 && effectivePhase === 1) ||
                 (curStepper === 4 && effectivePhase === 2) ) {
                // step out
                updateWriteStream();
                physTrack = (physTrack === 0) ? 0 : (physTrack - 1);
                cancelReadByte();
                if (floppy_dbg) {
                    console.log(devName + ' step out: physTrack=' + physTrack);
                }
            } else if ( (curStepper === 1 && effectivePhase === 2) ||
                        (curStepper === 2 && effectivePhase === 4) ||
                        (curStepper === 4 && effectivePhase === 1) ) {
                // step in
                updateWriteStream();
                physTrack = (physTrack === 40) ? 40 : (physTrack + 1);
                cancelReadByte();
                if (floppy_dbg) {
                    console.log(devName + ' step in:  physTrack=' + physTrack);
                }
            }
            curStepper = effectivePhase;

            // deselecting write: commit any residual write stream
            // before switching it off
            if (curWrite && !write) {
                updateWriteStream();
            }

            // newly enabled write:
            if (write && (!curWrite || !curSelected)) {
                cancelReadByte();
                writeStart = ccemu.getTickCount();
                if (floppy_dbg) {
                    console.log(devName + ' enabling write mode @ T=' + ccemu.getTickCount());
                }
            }
            curWrite = write;

            // engage read logic as appropriate
            if (!write && !readByteTimer) {
                if (floppy_dbg) {
                    console.log(devName + ' kicking off scheduleReadByte');
                }
                scheduleReadByte();
            }

        } else if (curSelected) {  // deselect

            var body_bg = $('body').css('background-color');
            $('#CD' + unit).css('background-color' , body_bg);
            if (floppy_dbg) {
                console.log(devName + ' deselecting');
            }

            updateWriteStream();
            cancelReadByte();

            assert(!motorTimer, "Didn't expect motorTimer to be active");
            // when deselected, the motor continues to run for about .68s
            // due to a 10uF cap and a 100K resistor
            var motor_ticks = CPU_FREQ * 0.68;
            if (floppy_dbg) {
                console.log(devName + ' creating motor timeout at tick ' + ccemu.getTickCount());
            }
            motorTimer = scheduler.oneShot(motor_ticks, motorCallback,
                                           devName + "motor");
            if (floppy_dbg) {
                console.log(devName + ' motor timer id=' + motorTimer.id);
            }

            curSelected = 0;
            curWrite = 0;
        }
    }

    function motorCallback() {
        if (floppy_dbg) {
            console.log(devName + ' motor timed out at tick ' + ccemu.getTickCount() + ', id=' + motorTimer.id);
        }
        assert(motorTimer !== undefined);
        var elapsed = motorTimer.age();
        motorTimer = undefined;
        advancePositionNTicks(elapsed);
    }

    // parse the block level representation and map it to track level
    // bit transition information.
    // Note: physical track is formatted and the ID blocks are tagged
    //       as being track 0, and 41 tracks are so formatted.
    //       However, FCS puts logical track 0 onto physical track 1.
    function insertFloppy(image) {

        var magicSeen = 0;
        var curTrack = -1;
        var hexBytes = [];   // accumulation of the bytes for this sector
        var lines = image.split(/\r\n|\r|\n/g);
        var linesLen = lines.length;
        var lineNum;
        var trackData = [];
        var limit;              // number of bytes per track or sector
        var mo;                 // match object
        var n;

        writeProtected = 0;     // until indicated otherwise
        label = [];

        var dummySector = new Array(128);
        for (n = 0; n < 128; n++) {
            dummySector[n] = 0xE5;
        }

        for (lineNum=1; lineNum <= linesLen; lineNum++) {
            var line = lines[lineNum - 1];
            // strip leading and trailing spaces
            line = line.replace(/^\s+|\s+$/g, '');
            // ignore blank lines
            if (/^$/.test(line)) {
                continue;
            }
            // ignore comment lines
            if (/^(#|\/\/)/.test(line)) {
                continue;
            }

            // the file should start with this magic string
            if (/^compucolor virtual floppy/i.test(line)) {
                magicSeen = 1;
                continue;
            }
            if (!magicSeen) {
                alert('Error: not a valid ccvf file: missing magic string, line ' + lineNum);
                return 1;  // error
            }

            // look for write protect flag
            if (/^write protect$/i.test(line)) {
                writeProtected = 1;
                continue;
            }

            // look for label declarations
            mo = /^label (.*)$/i.exec(line);
            if (mo) {
                label.push(mo[1]);
                continue;
            }

            // look for track tag
            mo = /^track (\d+)/i.exec(line);
            if (mo) {
                limit = 15360/8;  // bytes per track
                var newTrack = parseInt(mo[1],10);
                if (hexBytes.length !== 15360/8 && curTrack >= 0) {
                    alert('Error: at line ' + lineNum + ', a new track is started but\n' +
                          "previous sector didn't supply a full track of data");
                    return 1;  // error
                }
                if (newTrack !== curTrack+1) {
                    alert('Error: at line ' + lineNum + ', track ' + newTrack +
                          ' was found, expected track ' + (curTrack+1));
                    return 1;  // error
                }
                if (newTrack >= 41) {
                    alert('Error: at line ' + lineNum + ', track ' + newTrack +
                          ' was found, but at most 41 are allowed');
                    return 1;  // error
                }
                curTrack++;
                hexBytes = [];
                continue;
            }

            // look for hex data associated with previous TRACK tag
            if (/^[0-9A-Fa-f]+$/.test(line)) {
                if (line.length % 2 === 1) {
                    alert('Error: at line ' + lineNum +
                          ' there are an odd number of hex digits');
                    return 1;  // error
                }
                var lineBytes = [];
                for (n = 0; n < line.length; n += 2) {
                    lineBytes.push(parseInt(line.substr(n, 2), 16));
                }
                if (hexBytes.length < limit &&
                    hexBytes.length + lineBytes.length > limit) {
                    alert('Error: at line ' + lineNum +
                          ' there are more than ' + limit + ' bytes of data');
                    return 1;  // error
                }
                hexBytes = hexBytes.concat(lineBytes);
                if (hexBytes.length === limit) {
                    trackData.push(hexBytes);
                }
                continue;
            }

            // don't know what this line is
            alert('Error: unknown format at line ' + lineNum);
            return 1;  // error
        }

        if (hexBytes.length !== limit && curTrack >= 0) {
            alert('Error: at line ' + lineNum + ', end of file seen but\n' +
                  'final track didn\'t supply ' + limit + ' bytes of data');
            return 1;  // error
        }

        diskImage = trackData;

        // UI update
        var volLabel = decodeVolumeLabel();
        $('#CD' + unit + 'Label').html(volLabel);
    }

    // this is a lot of work for a little gain, but whatever...
    // after inserting a disk, decode sector 0 so we can
    // find the volume label to display it in the UI.
    // the track is the logical track.
    // this function doesn't check for framing errors and CRC
    // errors.  If this function is used for something more trivial
    // than fetching the volume label, it should be made more robust.
    function decodeSector(trk, sec) {
        var trkdat = diskImage[trk+1]; // logical track n is physical n+1
        var bitptr = 0;
        var limit = bitsPerTrack * 1.5;
        function getBit(offset) {
            var off = bitptr + offset;
            if (off > bitsPerTrack) { off -= bitsPerTrack; }
            return ((trkdat[off >> 3] >> (off & 7)) & 1);
        }
        // skip to next gap (about 5 char times of all zeros)
        function findGap() {
            var run = 0;
            while (bitptr < limit && run < 50) {
                var bit = getBit(0);
                run = (bit) ? (run+1) : 0;
                bitptr++;
            }
        }
        // find next start bit, then read 10b
        function nextByte() {
            var prev = getBit(-1);
            var cur  = getBit(0);
            // find a start bit
            while (!prev || cur) {
                bitptr++;
                prev = cur;
                cur = getBit(0);
            }
            bitptr++; // skip over start bit
            var val = 0;
            for(var n = 0; n < 8; n++) {
                val |= (getBit(0) << n);
                bitptr++;
            }
            // var stop = getBit(0);
            bitptr++;
            return val;  // ignore stop bit errors for now
        }

        while (bitptr < limit) {
            var b;
            findGap();
            b = nextByte();
            if (b !== 0x55) { continue; }  // ID mark
            b = nextByte();
            if (b !== trk+1) { continue; }  // wrong track
            b = nextByte();
            if (b !== sec) { continue; }  // wrong sector
            b = nextByte();  // crc byte 0 -- ignored
            b = nextByte();  // crc byte 1 -- ignored
            b = nextByte();  // dummy byte #1
            b = nextByte();  // dummy byte #2
            if (b !== 0x5A) {
                b = nextByte();  // (dummy) byte #3
                if (b !== 0x5A) {
                    b = nextByte();  // byte #4
                    if (b !== 0x5A) { continue; }
                }
            }
            var bytes = [];
            for (var n = 0; n < 128; n++) {
                bytes[n] = nextByte();
            }
            return bytes;
            // two crc bytes follow; ignored for now
        } // while
        return undefined;  // didn't find it
    }

    // read track 0, sector 0; extract the volume label if possible
    function decodeVolumeLabel() {
        var bytes = decodeSector(0, 0);
        var volLabel = '';
        if ( (bytes === undefined) ||   // couldn't decode it
             (bytes[0] !== 0x00)   ||   // block number
             (bytes[2] !== 0x41)) {     // volume attribute byte
            volLabel = '--occupied--';
        } else {
            for (var n = 3; n < 13; n++) {
                var b = bytes[n];
                if (b >= 32 && b <= 64+26) {
                    volLabel = volLabel + String.fromCharCode(b);
                }
            }
        }
        return volLabel;
    }

    return {
        'constructor'  : Floppy,
        'getPosition'  : function () { return curPosition; },  // FIXME: here just for debugging
        'reset'        : reset,
        'select'       : select,
        'getStatus'    : getStatus,
        'txData'       : txData,
        'insertFloppy' : insertFloppy,
        'removeFloppy' : removeFloppy,
        'getFile'      : getFile
    };
}

//============================================================================
// debugging utility
//============================================================================

function assert(test, msg) {
    if (!test) {
        if (msg === undefined) { msg = 'Oops!'; }
        throw {
            message: msg,
            name: 'assertion error'
        };
    }
}

// vim:et:sw=4:
