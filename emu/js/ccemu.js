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

// These are the names which pollute the global object.  The only one which
// the webpage should interact with is ccemu - the rest are exposed out of
// laziness.
//
//     tms5501   -- timers, serial and parallel ports
//     smc5027   -- CRT controller
//     keybrd    -- emulated keyboaMath.floor
//     autotyper -- send a stream of text lines to the BASIC interpreter
//     crt       -- colorcomputer display
//     scheduler -- an 8080-tick based scheduler
//     floppy    -- two floppy disk drives
//     ccemu     -- the master controller:
//                      all webpage requests go to this object

// option flags for jslint:
/* global console, alert */
/* global Cpu, Floppy, crt, tms5501, smc5027, keybrd, autotyper, scheduler */
/* global system_rom_6_78, system_rom_8_79 */
/* global floppy_dbg */

// GLOBALS
var cpu,
    floppy = [];

//============================================================================
// emu core
//============================================================================

var ccemu = (function () {

    'use strict';

    // (17.9712 MHz / 9) = 1.9968 MHz =  501 ns cpu clock
    var CPU_FREQ = 1996800;

    // this is the compucolor ROM< display, and program DRAM lives.
    // 64K will be initialized, but accessor functions make sure only some
    // ranges will be accessed.
    var ram = [];

    // a place to park feature detection results
    var browserSupports = {};

    var numFloppies = 2;

    // --------------------------- constants --------------------------

    // although the timeslice is set at 30 Hz, it doesn't have to be tied
    // at the screen update rate
    var TIMESLICE_MS = 33;    // 30 Hz

    // ----------------- ram and port dispatch routines -----------------

    // in the address range 0x7000-0x7FFF, the CPU is stalled during the
    // interval the video generation logic is using the video RAM, and
    // the CPU can access it only during hblanking.  This is the code
    // which performs that wait.  we must let timers advance during this
    // wait, as the wait can be nearly 60 uS long.
    function waitForHblank() {
        var granularity = 4;  // in real life 1, but that is expensive
        while (!smc5027.hBlank()) {
            tickCount += granularity;
            scheduler.tick(granularity);
        }
    }

    function rd(addr) {
        var aa = addr & 0xffff;
        if (0x6000 <= aa && aa < 0x7000) {
            // fast refresh video RAM
            return ram[aa + 0x1000];
        }
        if (0x7000 <= aa && aa < 0x8000) {
            // slow refresh video RAM
            waitForHblank();
            return ram[aa];
        }
// if (aa >= 48*1024) {  // simulate 16K RAM
//     return 0xFF;
// }
        // either ROM (low memory) or 32K of DRAM (high memory)
        return ram[aa];
    }

    // allow writing anywhere, including ROM
    // it doesn't map video RAM either
    function wrUnsafe(addr, data) {
        var aa = addr & 0xffff;
        var bb = data & 0xff;
        ram[aa] = bb;
    }

    // write only to valid R/W locations in the real machine
    function wr(addr, data) {
        var aa = addr & 0xffff;
        var bb = data & 0xff;
        if (0x6000 <= aa && aa < 0x7000) {
            // fast refresh video RAM
            ram[aa + 0x1000] = bb;
            crt.updateChar(aa + 0x1000);
        } else if (0x7000 <= aa && aa < 0x8000) {
            // slow refresh video RAM
            waitForHblank();
            ram[aa] = bb;
            crt.updateChar(aa);
        } else if (aa >= 0x8000) {
            // 32K of DRAM
            ram[aa] = bb;
        }
    }

    function input(port) {

        // TMS5501 I/O chip
        if (port >= 0x00 && port <= 0x1F) {
            return tms5501.rd(port & 0x0F);
        }

        // SMC 5027 CRT chip
        // The compucolor drives the chip's !DS (data strobe) input from the
        // 8080 !IOW signal (I/O write).  This means the part isn't selected
        // on reads.
        // if (0 && (port >= 0x60 && port <= 0x7F)) {
        //     return smc5027.rd(port & 0x0F);
        // }

        // the service manual claims those are the only two i/o devices,
        // but the ROM reads from IN port 0x80 to 0x86 and uses those values
        // to initialize the 5027 registers 0x60-0x65.  A small ROM lives at
        // that address.  It is 32 words, but only the first seven are read
        // by the boot code.
        //
        // It turns out that most machines didn't have this PROM installed
        // because the machine used a mask ROM version of the 5027.
        // if (0x80 <= port && port < 0x9F) {
        //     return crt_timing_rom[port - 0x80];
        // }

        // it turns out that in real hardware, INP(P) for an unmapped port P
        // returns P!  This is because the last byte on the data bus was P,
        // and when a read is performed, nothing is selected so nothing drives
        // the data bus, so residual capacitance causes the last value on the
        // bus, the 2nd byte of "IN #" to be seen.
        return port;  // unmapped address
    }

    function output(port, value) {

        // TMS5501 I/O chip
        if ( (port >= 0x00 && port <= 0x0F) ||
             (port >= 0x10 && port <= 0x1F) ) {
            return tms5501.wr(port & 0x0F, value);
        }

        // SMC 5027 CRT chip
        if ( (port >= 0x60 && port <= 0x6F) ||
             (port >= 0x70 && port <= 0x7F) ) {
            return smc5027.wr(port & 0x0F, value);
        }
    }

    // --------------------- core emulator routines --------------------

    // send reset to all the devices
    function warmReset(comingFromAutotyper) {
        cpu.reset();
        tms5501.reset();     // timer & i/o interface chip
        smc5027.reset();     // video timing controller
        keybrd.reset();      // keyboard
        for (var n = 0; n < numFloppies; n++) {
            floppy[n].reset();
        }

        // [[[RESET]]] from the autotyper input text can force a reset,
        // but we don't want that to also kill the autotyper
        if (!comingFromAutotyper) {
            autotyper.cancel();  // autotype module
        }

        update(cpu);         // refresh display
    }

    // BASIC checks a certain location for the magic value 97H to determine
    // if this is a cold start (in which case 97H would be an unlikely
    // random value).  After starting, 97H is written there so on the next
    // reset it knows this is a warm reset.  So, to force the cold reset,
    // we set that value to 00H.
    function hardReset(comingFromAutotyper) {
        var CRTRAM = 0x81AF;   // see fcs.asm
        var PUP = CRTRAM + 8;  // "PUP" (power up) flag
        warmReset(comingFromAutotyper);
        wr(PUP, 0x00);
    }

    // real time clock
    function realtime() {
        return new Date().getTime();
    }

    // performance throttle
    var cpuClocksPerTimeslice = (CPU_FREQ * TIMESLICE_MS / 1000);
    var tickCount = 0;        // cumulative 8080 ticks

    // track what fraction of real time we are consuming during emulation
    var timeHistoryWindow = 15;  // how many slices to average over
    var timeHistory = [];        // circular buffer
    var timeHistoryPtr = 0;      // circular buffer pointer
    var timeFractionBusy = 1.0;  // portion of time emulation consumes
    var showTiming = false;

    // javascript uses doubles for numbers, which offer 53b of integer
    // precision, so running at 2MHz, the tickCount will start losing
    // time after 142.8 years of continuous operation.
    function getTickCount() {
        return tickCount;
    }

    function doCpuTimeslice() {

        // if we are running the autotyper, speed up the cpu in order
        // to reduce the wait to stream in the file.  aim for 90%.
        var autotyping = autotyper.isRunning();
        // 2.0 instead of 1.0 because timeFractionBusy, for unknown reasons,
        // indicates more CPU utilization than is real
        var boost = 2.0 / timeFractionBusy;
        var sliceClkLimit = (autotyping) ? boost*cpuClocksPerTimeslice :
                                                 cpuClocksPerTimeslice;

        var tStart = realtime();
        var tickLimit = tickCount + sliceClkLimit;
        for (var i = 0; tickCount < tickLimit; ++i) {
            singleStep();
        }
        var tEnd = realtime();

        // figure out what percent of realtime we are using
        // skip it during autotyping because we have boosted the CPU
        if (!autotyping) {
            var tDiff = tEnd - tStart;
            timeHistory[timeHistoryPtr] = tDiff;
            timeHistoryPtr = (timeHistoryPtr + 1) % timeHistoryWindow;
            if (timeHistory.length === timeHistoryWindow) {
                var tTotal = 0;
                for (var tt = 0; tt < timeHistory.length; tt++) {
                    tTotal += timeHistory[tt];
                }
                timeFractionBusy = tTotal / (timeHistory.length * TIMESLICE_MS);
            }

            if (showTiming) {
                var percent = (100*timeFractionBusy).toFixed(0).toString();
                while (percent.length < 3) { percent = " " + percent; }
                percent = "Emulator consumes <tt>" + percent +
                          "%</tt> of your CPU";
                setTimeReport(percent);
            }
        }
    }

    // exectute one instruction at the current PC
    function singleStep() {
        var cycles;
        try {
            if (floppy_dbg) {
                if (cpu.pc === 0x2286) { console.log('@FG4: gap found'); }
                if (cpu.pc === 0x22A0) { console.log('@22A0: read header 2nd crc byte, T=' + getTickCount() + ', offset=' + floppy[0].getPosition()); }
                if (cpu.pc === 0x22A0) { console.log('@22A0: DE=' + cpu.de().toString(16)); }
                if (cpu.pc === 0x22A5) { console.log('@HER1: wrong track or bad header crc'); }
                if (cpu.pc === 0x22DB) { console.log('@GH1: good header'); }
                if (cpu.pc === 0x22DE) { console.log('@GH1b: looking for trk=' + (cpu.af()>>8).toString(16)); }
            //  if (cpu.pc === 0x22E2) { console.log('@GH2: track ok'); }
                if (cpu.pc === 0x22E5) { console.log('@GH2b: looking for sec=' + (cpu.af()>>8).toString(16) + ', actual=' + (cpu.hl() & 0xFF).toString(16)); }
                if (cpu.pc === 0x22E9) { console.log('@GH3: track ok, sector wrong'); }
                if (cpu.pc === 0x22F3) { console.log('@GH4: found sector, T=' + getTickCount()); }
                if (cpu.pc === 0x2411) { console.log('@RD00: looking for data mark'); }
            //  if (cpu.pc === 0x244A) { console.log('@244A: DE=' + cpu.de().toString(16) + ', HL=' + cpu.hl().toString(16)); }
                if (cpu.pc === 0x2305) { console.log('@2305: @VE00'); }
                if (cpu.pc === 0x230B) { console.log('@230B: @VERR'); }
                if (cpu.pc === 0x2322) { console.log('@2322: @VE01'); }
                if (cpu.pc === 0x2325) { console.log('@2325: @VE01b: read ' + (cpu.af()>>8).toString(16) + ', expecting ' + rd(cpu.hl()).toString(16) + ', hl=' + cpu.hl().toString(16)); }
                if (cpu.pc === 0x232A) { console.log('@232A: @VE02'); }
                if (cpu.pc === 0x2336) { console.log('@2336: @VE03'); }
                if (cpu.pc === 0x233D) { console.log('@233D: @VE04'); }
                if (cpu.pc === 0x23B4) { console.log('@23B4: writing dummy byte FF, T=' + getTickCount() + ', offset=' + floppy[0].getPosition()); }
                if (cpu.pc === 0x24CB) { console.log('@24CB: @GDATAMb: read ' + (cpu.af()>>8).toString(16)); }
                if (cpu.pc === 0x24CE) { console.log('@24CE: @GDATAMc: read ' + (cpu.af()>>8).toString(16)); }
                if (cpu.pc === 0x24D4) { console.log('@24D4: @GDATAMd: read ' + (cpu.af()>>8).toString(16)); }
                if (cpu.pc === 0x24DA) { console.log('@24DA: @GDATAMe: read ' + (cpu.af()>>8).toString(16)); }
            }
            cycles = cpu.step();
            tickCount += cycles;
            scheduler.tick(cycles);  // look for ripe events
        }
        catch (err) {
            alert('Error name: ' + err.name + ', message: ' + err.message);
        }

        return cycles;
    }

    function halt() {
        if (ccemu.interval) {
            clearInterval(ccemu.interval);
        }
        delete ccemu.interval;
        clearTimeReport();
        $('#debuginfo').show(300);
        update(cpu);
    }

    function debugging() {
        return (ccemu.interval === undefined);
    }

    // --------------------- UI routines --------------------

    function pad(str, n) {
        var r = [];
        for (var i = 0; i < (n - str.length); ++i) {
            r.push('0');
        }
        r.push(str);
        return r.join('');
    }

    function hex16(n) {
        return pad(n.toString(16), 4);
    }

    function update(cpu) {
        // FIXME: this should be exported by Cpu
        function flags(cpu) {
            return (cpu.f & Cpu.ZERO ? 'z' : '.') +
                   (cpu.f & Cpu.SIGN ? 's' : '.') +
                   (cpu.f & Cpu.PARITY ? 'p' : '.') +
                   (cpu.f & Cpu.INTERRUPT ? 'i' : '.') +
                   (cpu.f & Cpu.CARRY ? 'c' : '.');
        }
        $('#af').html(hex16(cpu.af()));
        $('#bc').html(hex16(cpu.bc()));
        $('#de').html(hex16(cpu.de()));
        $('#hl').html(hex16(cpu.hl()));
        $('#pc').html(hex16(cpu.pc));
        $('#sp').html(hex16(cpu.sp));
        $('#flags').html(flags(cpu));
        $('#disassemble').html(cpu.disassemble(cpu.pc)[0]);
        crt.refreshDisplay();
        crt.blitDisplay();
    }

    // FileReader code modified from here:
    // http://stackoverflow.com/questions/3146483/html5-file-api-read-as-text-and-binary
    // (attached to a UI button)
    function autorunLocalFile() {
        function receivedText() {
            autotyper.start(fr.result);
        }
        var input = document.getElementById('fileinput');
        var file = input.files[0];
        var fr = new FileReader();
        fr.onload = receivedText;
        fr.readAsText(file);
//      fr.readAsBinaryString(file);
    }

    // load a named file
    // (attached to a UI button)
    function autotypeRemoteFile(fileURL) {
        $.get(fileURL, function(responseTxt) {
            // take the focus off the control, otherwise subsequent
            // keyboard events can activate it inadvertently
            $('#filesel').blur();
            autotyper.start(responseTxt);
        }, 'html')
         .fail(function () { alert('File failed to load!'); });
    }

    function diskPick(unit) {
        var di = $('#diskinput' + unit);
        var ds = $('#disksel' + unit);
        var val = ds[0].value;
        if (val === "empty") {
            floppy[unit].removeFloppy();
        } else if (val === 'local') {
            // activate the hidden local file browser control
            di.click();
        } else if (val !== 'prompt') {
            diskRemoteFile(unit, val);
        }
        ds[0].selectedIndex = 0;
        ds.blur();
    }

    function diskDump(unit) {
        var text = floppy[unit].getFile();
        var win = window.open('', 'diskwindow',
            'width=350,height=350,menubar=1,toolbar=1,status=0,scrollbars=1,resizable=1');
        if (win) {
            for(var n = 0; n < text.length; n++) {
                win.document.write(text[n] + '<br/>');
            }
            win.document.close();
        }
    }

    function diskInput(unit) {
        var input = document.getElementById('diskinput' + unit);
        var file = input.files[0];
        var fr = new FileReader();
        fr.onload = receivedText;
        fr.readAsText(file);
//      fr.readAsBinaryString(file);
        function receivedText() {
            floppy[unit].insertFloppy(fr.result);
        }
    }

    // load a named file
    // (attached to a UI button)
    function diskRemoteFile(unit, fileURL) {
        $.get(fileURL, function(responseTxt) {
            // take the focus off the control, otherwise subsequent
            // keyboard events can activate it inadvertently
            $('#disksel' + unit).blur();
            floppy[unit].insertFloppy(responseTxt);
        }, 'html')
         .fail(function () { alert('File failed to load!'); });
    }

    function setTimeReport(msg) { $('#runnmsg').html(msg); }
    function clearTimeReport()  { $('#runnmsg').html(''); }

    // (attached to a UI button)
    function run1()
    {
        halt();
        clearTimeReport();
        singleStep();
        update(cpu);
    }

    // (attached to a UI button)
    function runn()
    {
        halt();
        var n = parseInt($('#nval')[0].value, 10);
        var start = realtime();
        for (var i = 0; i < n; ++i) {
            singleStep();
        }
        var end = realtime();
        update(cpu);
        setTimeReport('That took ' + (end - start).toString() + ' ms');
    }

    // request "run", "debug" or "toggle"
    function runOrDebug(action) {

        if (ccemu.interval) {
            clearInterval(ccemu.interval);
        }

        var label = $('#run_debug').html();
        if (action === 'toggle') {
            action = (label === 'Run') ? 'run' : 'debug';
        }

        if (action === 'run') {
            // Run mode: switch label to Debugger
            $('#run_debug').html('Debugger...');
            $('.debugger').hide(300);
            if (!showTiming) {
                clearTimeReport();
            }
            ccemu.interval = setInterval(function () {
                doCpuTimeslice();
            }, TIMESLICE_MS);
        } else {
            // Debug mode: switch label to run
            $('#run_debug').html('Run');
            $('.debugger').show(300);
            halt();
        }
    }

    // center the screen on the window
    // center the progress bar in the middle of the screen
    function updateScreenPlacement() {
        var canvasW = crt.getCanvasSize()[0];
        var borderW = $('#canv').css('border-left-width').replace('px','');
        var screenW = canvasW + 2*borderW;
        var screen = $('#screen');
        screen.width(screenW);
    }

    // the most recently set screen scaling factor.
    // must be a string matching the element 'value'.
    var prevCanvasScale = '1.00';

    function setScreenSize(idx, scaling) {
        // take the focus off the control, otherwise subsequent
        // keyboard events can activate it inadvertently
        $('#ssizesel').blur();
        var scalingf = parseFloat(scaling);
        if (scalingf > 4) {
            var e = document.getElementById('screen');
            // scale up from a crisp image, not something already interpolated
            crt.setCanvasSize(1.0);
            launchFullScreen(e);
        } else {
            // whatever was asked for
            crt.setCanvasSize(scalingf);
            prevCanvasScale = scaling;
            updateScreenPlacement();
            crt.markDirty();
            crt.blitDisplay();
        }
    }

    // make the chosen element take up the whole screen
    function launchFullScreen(element) {
        var f = element.requestFullScreen    ||
                element.mozRequestFullScreen ||
                element.webkitRequestFullScreen;
        if (f) {
            f.call(element, Element.ALLOW_KEYBOARD_INPUT);
        }
    }

    function setCharacterset(idx) {
        // take the focus off the control, otherwise subsequent
        // keyboard events can activate it inadvertently
        $('#chsetsel').blur();
        crt.setCharset(idx);
        crt.markDirty();
        crt.refreshDisplay();
    }

    function setROMidx(idx) {
        // take the focus off the control, otherwise subsequent
        // keyboard events can activate it inadvertently
        $('#romsel').blur();
        var name = (idx === 0) ? 'v6.78' : 'v8.79';
        setROMVersion(name);
        ccemu.hardReset();
    }

    function populateFilePulldown(id) {
        var files = [
            { label: 'Acey Deucy',     value: 'source/aceyducy.ccc'  },
            { label: 'Biorhythm',      value: 'source/bioryth.ccc'   },
            { label: 'Black Jack',     value: 'source/blakjack.ccc'  },
            { label: 'Concentration',  value: 'source/concnumb.ccc'  },
            { label: 'Line 5',         value: 'source/linefive.ccc'  },
            { label: 'Lunar Lander',   value: 'source/lander.ccc'    },
            { label: 'Math Dice',      value: 'source/mathdice.ccc'  },
            { label: 'Math Tutor',     value: 'source/mathtu.ccc'    },
            { label: 'Othello',        value: 'source/othello.ccc'   },
            { label: 'Shoot',          value: 'source/shoot.ccc'     },
            { label: 'Slot Machine',   value: 'source/slot.ccc'      },
            { label: 'Tic Tac Toe',    value: 'source/tictacto.ccc'  },
            { label: 'Two to Ten',     value: 'source/twototen.ccc'  }
        ];
        var pd = $(id);
        var opttag = '<option></option>';
        pd.append($(opttag).val('prompt').text('Select a file...'));
        if (browserSupports.fileApi) {
            pd.append($(opttag).val('local').text('Use local file...'));
        }
        for (var n=0; n<files.length; n++) {
            pd.append($(opttag).val(files[n].value).text(files[n].label));
        }
    }

    function populateFloppyPulldown(id) {
        var disks = [
            { label: 'BASIC Utilities', value: 'disks/BASIC_utilities.ccvf' },
            { label: 'Blackjack',       value: 'disks/blackjack.ccvf'       },
            { label: 'Disk Formatter',  value: 'disks/formatter.ccvf'       },
            { label: 'Hangman',         value: 'disks/hangman.ccvf'         },
            { label: 'Sampler',         value: 'disks/sampler.ccvf'         },
            { label: 'Sharks',          value: 'disks/sharks.ccvf'          },
            { label: 'Swarms',          value: 'disks/swarms.ccvf'          }
        ];
        var pd = $(id);
        var opttag = '<option></option>';
        pd.append($(opttag).val('prompt').text('Select a disk...'));
        // FIXME: make this conditional:
        if (1) {
            pd.append($(opttag).val('empty').text('--empty--'));
        }
        if (browserSupports.fileApi) {
            pd.append($(opttag).val('local').text('Use local file...'));
        }
        for (var n=0; n<disks.length; n++) {
            pd.append($(opttag).val(disks[n].value).text(disks[n].label));
        }
    }

    function bindEvents() {

        // add "Fullscreen" screen size option only if the browser supports it
        if (browserSupports.fullscreen) {
            var e = document.getElementById('canv');
            $('#ssizesel').append('<option value="999">Fullscreen');

            // detect when we exit fullscreen mode so we can set the choice
            // box back to what it was before entering fullscreen mode
            if (document.addEventListener !== undefined) {
                var evn = (e.requestFullScreen)    ? "fullscreenchange" :
                          (e.mozRequestFullScreen) ? "mozfullscreenchange" :
                                                     "webkitfullscreenchange";
                document.addEventListener(evn, function () {
                    // there is some confusion about how to spell it!
                    var fullscreenMode = document.fullscreenElement       ||
                                         document.fullScreenElement       ||
                                         document.mozFullscreenElement    ||
                                         document.mozFullScreenElement    ||
                                         document.webkitFullscreenElement ||
                                         document.webkitFullScreenElement;
                    if (!fullscreenMode) {
                        // revert the size selector
                        $('#ssizesel').val(prevCanvasScale);
                        crt.setCanvasSize(prevCanvasScale);
                    }
                });
            }
        }

        // tie buttons to events
        $('#hardreset').click(function () {
            hardReset();
            $('#hardreset').blur();
        });
        $('#warmreset').click(function () {
            warmReset();
            $('#warmreset').blur();
        });
        $('#auto').click(function () {
            keybrd.forceKey('auto', true, true);
            $('#auto').blur();
        });
        $('#fileinput').change(autorunLocalFile);
        $('#filesel').change(function () {
            var val = $('#filesel')[0].value;
            if (val === "local") {
                // activate the hidden local file browser control
                $('#fileinput').click();
            } else if (val !== "prompt") {
                autotypeRemoteFile(val);
            }
            $('#filesel')[0].selectedIndex = 0;
            $('#filesel').blur();
        });
        for (var n = 0; n < numFloppies; n++) {
            $('#diskinput' + n).change( (function (i) {
                return function () { diskInput(i); };
            })(n));
            $('#disksel' + n).change( (function (i) {
                return function () { diskPick(i); };
            })(n));
            $('#drive' + n).click( (function (i) {
                return function (evt) { if (evt.ctrlKey) { diskDump(i); } };
            })(n));
        }
        $('#ssizesel').change(function () {
            var index = $('#ssizesel')[0].selectedIndex;
            var val = $('#ssizesel')[0].value;
            setScreenSize(index, val);
        });
        $('#chsetsel').change(function () {
            var index = $('#chsetsel')[0].selectedIndex;
            setCharacterset(index);
        });
        $('#romsel').change(function () {
            var index = $('#romsel')[0].selectedIndex;
            setROMidx(index);
        });
        $('#run_debug').click(function () {
            runOrDebug('toggle');
            $('#run_debug').blur();
        });
        $('#run1').click(run1);
        $('#runn').click(runn);

        // note: all uses are using non-ascii encoding strings,
        //       and when it gets down into encodeASCII, it uses the
        //       ambient values of PC shift&control for the CC versions,
        //       so we don't have to pass them.
        function bindVirtualKey(selector, encoding) {
            $(selector).mousedown(function ()  { keybrd.forceKey(encoding, true, true); });
            $(selector).mouseup(function ()    { keybrd.clearKey(); });
            $(selector).mouseleave(function () { keybrd.clearKey(); });
        }

        // connect color keys
        bindVirtualKey('button#black',   'black');
        bindVirtualKey('button#blue',    'blue');
        bindVirtualKey('button#red',     'red');
        bindVirtualKey('button#magenta', 'magenta');
        bindVirtualKey('button#green',   'green');
        bindVirtualKey('button#cyan',    'cyan');
        bindVirtualKey('button#yellow',  'yellow');
        bindVirtualKey('button#white',   'white');

        bindVirtualKey('button#F0',      'F0');
        bindVirtualKey('button#F1',      'F1');
        bindVirtualKey('button#F2',      'F2');
        bindVirtualKey('button#F3',      'F3');
        bindVirtualKey('button#F4',      'F4');
        bindVirtualKey('button#F5',      'F5');
        bindVirtualKey('button#F6',      'F6');
        bindVirtualKey('button#F7',      'F7');
        bindVirtualKey('button#F8',      'F8');
        bindVirtualKey('button#F9',      'F9');
        bindVirtualKey('button#F10',     'F10');
        bindVirtualKey('button#F11',     'F11');
        bindVirtualKey('button#F12',     'F12');
        bindVirtualKey('button#F13',     'F13');
        bindVirtualKey('button#F14',     'F14');
        bindVirtualKey('button#F15',     'F15');

        bindVirtualKey('button#auto',    'auto');
        bindVirtualKey('button#fgon',    'fgon');
        bindVirtualKey('button#bgon',    'bgon');
        bindVirtualKey('button#blnkon',  'blinkon');
        bindVirtualKey('button#bla7off', 'bla7off');
        bindVirtualKey('button#a7on',    'a7on');
        bindVirtualKey('button#vis',     '[');
        bindVirtualKey('button#upa',     '\\');
        bindVirtualKey('button#block',   ']');
        bindVirtualKey('button#user',    '^');
        bindVirtualKey('button#crt',     '_');

        bindVirtualKey('button#epage',   'epage');
        bindVirtualKey('button#eline',   'eline');
//      bindVirtualKey('button#cpurst',  'cpurst'); // see below
        bindVirtualKey('button#epage',   'epage');

        bindVirtualKey('button#delchar', 'delchar');
        bindVirtualKey('button#inschar', 'inschar');
        bindVirtualKey('button#delline', 'delline');
        bindVirtualKey('button#insline', 'insline');

        // the reset button requires special handling.  we can't use
        // forceKey() since we aren't sending a character.
        $('button#cpurst').mousedown(function (evt) {
            if (evt.ctrlKey && evt.shiftKey) {
                ccemu.hardReset();
            } else {
                ccemu.warmReset();
            }
        });

        // wire up the virtual keyboard resizing controls
        function virtualKeyboardSize() {
            var vkbd = $('#virtualkeyboard');
            var vkButtons = $('#virtualkeyboard button');
            if ($('#vkNone').is(':checked')) {
                vkbd.hide(300);
            }
            if ($('#vkSmall').is(':checked')) {
                vkbd.show(300);
                vkButtons.css({ 'font-size': '8px' });
            }
            if ($('#vkMedium').is(':checked')) {
                vkbd.show(300);
                vkButtons.css({ 'font-size': '9px' });
            }
            if ($('#vkLarge').is(':checked')) {
                vkbd.show(300);
                vkButtons.css({ 'font-size': '10px' });
            }
        }
        $('#vkNone').click(virtualKeyboardSize);
        $('#vkSmall').click(virtualKeyboardSize);
        $('#vkMedium').click(virtualKeyboardSize);
        $('#vkLarge').click(virtualKeyboardSize);
        $('#vkNone').prop('checked', true);
    }

    function detectFeatures() {

        // fileAPI
        browserSupports.fileApi =
            (typeof window.FileReader === 'function') &&
            (document.getElementById('fileinput').files !== undefined);

        // fullscreen
        var e = document.getElementById('canv');
        browserSupports.fullscreen =
            (e.requestFullScreen !== undefined)      ||
            (e.mozRequestFullScreen !== undefined)   ||
            (e.webkitRequestFullScreen !== undefined);
    }

    function setROMVersion(name) {
        var system_rom;
        var stepper_phases;
        if (name === 'v6.78') {
            system_rom = system_rom_6_78;
            stepper_phases = 3;
        } else if (name === 'v8.79') {
            system_rom = system_rom_8_79;
            stepper_phases = 4;
        } else {
            alert("ERROR: setROMVersion called with " + name);
            system_rom = system_rom_6_78;
            stepper_phases = 3;
        }
        for (var i = 0; i < system_rom.length; ++i) {
            wrUnsafe(i, system_rom[i]);
        }
        // the floppy stepper type is tied to the ROM version
        for (i = 0; i < numFloppies; i++) {
            floppy[i].setStepperPhases(stepper_phases);
        }
    }

    // this is called when the DOM is completely loaded,
    // and begins the emulation
    function startEmu() {

        detectFeatures();

        // build our resources
        for (var i = 0; i < 65536; ++i) {
            wrUnsafe(i, 0);
        }

        cpu = new Cpu(ram, rd, wr, input, output);
        for(i = 0; i < numFloppies; i++) {
            floppy.push(new Floppy(i));
        }
        crt.init();
        smc5027.init();
        setROMVersion('v6.78');

        // set up period events -- return objects are ignored because they
        // are never canceled
        var displayPeriod = Math.floor(CPU_FREQ / 30);
        var tms5501Period = Math.floor(CPU_FREQ * 64 / 1000000);
        scheduler.periodic(displayPeriod, function () { crt.vsync(); }, "display");
        scheduler.periodic(tms5501Period, function () { tms5501.tick64us(); }, "5501");

        // set up the pulldown lists
        populateFilePulldown('#filesel');
        for(i = 0; i < numFloppies; i++) {
            populateFloppyPulldown('#disksel' + i);
        }
        // default selections:
        $('#filesel').val('prompt');
        for(i = 0; i < numFloppies; i++) {
            $('#disksel' + i).val('prompt');
        }
        $('#ssizesel').val('1.00');
        $('#chsetsel').val('Standard');
        $('#romsel').val('v6.78');

        // connect functions up to html elements
        bindEvents();

        // change this to "show()" if you want to allow selecting different
        // ROM versions
        $('#romdiv').show();

        // change this to "show()" if you want the debugger interface
        $('#run_debug').hide();

        updateScreenPlacement();

        hardReset();
        runOrDebug('run');
    }

    // expose public members:
    return {
        'startEmu':      startEmu,
        'getCpuFreq':    function () { return CPU_FREQ; },
        'getTickCount':  getTickCount,
        'rd':            rd,
        'wr':            wr,
        'hardReset':     hardReset,
        'warmReset':     warmReset,
        'debugging':     debugging
    };

}());  // ccemu

// jquery ready() is called once the DOM is fully loaded;
// without this there is no guarantee that the init code might attempt
// to attach event handlers to not-yet-existing DOM elements.
$(document).ready(function() {
    ccemu.startEmu();  // run the emulator
});

// vim:et:sw=4:
