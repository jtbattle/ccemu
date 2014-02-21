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
//     audio     -- soundware emulation
//     ccemu     -- the master controller:
//                      all webpage requests go to this object

// option flags for jslint:
/* global performance, alert, console */
/* global Cpu, Floppy, crt, tms5501, smc5027, keybrd, autotyper, scheduler */
/* global audio, store, system_rom_6_78, system_rom_8_79 */
/* global floppy_dbg, saveAs */

// GLOBALS
var cpu,
    floppy = [];

//============================================================================
// emu core
//============================================================================

var ccemu = (function () {

    'use strict';

    // optional UI features
    var enable_debug_interface = false; // simple 8080 debug monitor
    var enable_rom_selection = true;    // allow picking the ROM type
    var show_speed_regulation = true;   // show emulator speed throttle
    var regulated_cpu = true;           // throttle to match real ccII speed

    // (17.9712 MHz / 9) = 1.9968 MHz =  501 ns cpu clock
    var CPU_FREQ = 1996800;

    // this is the compucolor ROM< display, and program DRAM lives.
    // 64K will be initialized, but accessor functions make sure only some
    // ranges will be accessed.
    var ram = [];

    // a place to park feature detection results
    var browserSupports = {};

    var numFloppies = 2;

    var cur_system_rom;

    // emulation statistics
    var numCcSlices = 0,
        realMsConsumed = 0;

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
        floppy.forEach(function(elem) { elem.reset(); });
        if (browserSupports.audio) {
            audio.reset();   // soundware card
        }

        // [[[RESET]]] from the autotyper input text can force a reset,
        // but we don't want that to also kill the autotyper
        if (!comingFromAutotyper) {
            autotyper.cancel();  // autotype module
        }

        update();  // refresh display
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
        if (window.performance && window.performance.now) {
            return performance.now();
        } else {
            return Date.now();
        }
    }

    // performance throttle
    var cpuClocksPerTimeslice = (CPU_FREQ * TIMESLICE_MS / 1000);
    var tickCount = 0;        // cumulative 8080 ticks

    // javascript uses doubles for numbers, which offer 53b of integer
    // precision, so running at 2MHz, the tickCount will start losing
    // time after 142.8 years of continuous operation.
    function getTickCount() {
        return tickCount;
    }

    // if the audio buffer is underrunning, passing val=1 will cause
    // us to run a few percent more cycles per time slice than we should.
    // passing val=-1 means we have too many samples and we are getting
    // laggy, so we should reduce the number of cycles we are producing.
    // val=0 means schedule as normal
    var audioBoostFactor = 1.00;
    function audioBoostCpu(val) {
        audioBoostFactor = (val < 0) ? 0.98
                         : (val > 0) ? 1.02
                                     : 1.00;
    }

    function doCpuTimeslice() {

        // if we are running the autotyper, speed up the cpu in order
        // to reduce the wait to stream in the file.  aim for 90%.
        var autotyping = autotyper.isRunning();

        // if audio is enabled, we have a realtime constraint on the
        // production of audio samples, which is more important that
        // precise cpu speed regulation
        var sliceClkLimit = cpuClocksPerTimeslice * audioBoostFactor;

        var tStart = realtime(),
            tPrev = tStart;
        var tNow;
        var sliceMs, totMs;
        var tickLimit;
        var done = false;
        while (!done) {
            // simulate one slice worth of 8080 cycles
            tickLimit = tickCount + sliceClkLimit;

            while (tickCount < tickLimit) {
                singleStep();
            }
            // see how much real time has elapsed
            tNow = realtime();
            sliceMs = tNow - tPrev;
            totMs = tNow - tStart;
            tPrev = tNow;
            // quit if either we are trying to run realtime,
            // or if we predict the next slice will lead to
            // an overshoot of the time slice.
            done = (regulated_cpu && !autotyping) ||
                   (totMs + sliceMs >= 0.90*TIMESLICE_MS);
        }

        realMsConsumed += totMs;
        numCcSlices++;
    }

    // return the ration of a/b as a percentage string, left padded to 4 digits
    function percentage(a, b) {
        var p = (b > 0) ? (100*a / b) : 100;
        p = p.toFixed(0).toString();
        while (p.length < 4) { p = ' ' + p; }
        return p;
    }

    // display emulation statistics
    var lastCcSlices, lastCcTickCount, lastMsConsumed;
    var lastUpdate = 0;
    function updateStats() {
        var deltaCcCycles = getTickCount() - lastCcTickCount;
        var deltaCcSlices = numCcSlices - lastCcSlices;
        var deltaMsConsumed = realMsConsumed - lastMsConsumed;
        var tNow = realtime();

        var load = percentage(deltaMsConsumed, (tNow - lastUpdate));
        var speed = percentage(deltaCcCycles, deltaCcSlices * cpuClocksPerTimeslice);

        var label = '<input type="checkbox" id="regulate_cb" ' +
                        ((regulated_cpu) ? 'checked' : '') +
                    '>' + speed + '%';
        $('#regulation_label').html(label);

        lastCcTickCount = getTickCount();
        lastCcSlices = numCcSlices;
        lastMsConsumed = realMsConsumed;
        lastUpdate = tNow;

        // unused:
        load = load;
    }

    // exectute one instruction at the current PC
    function singleStep() {
        var cycles;
        if (0 && floppy_dbg) {
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

        return cycles;
    }

    function halt() {
        if (ccemu.interval) {
            clearInterval(ccemu.interval);
        }
        delete ccemu.interval;
        $('#debugger').show(300);
        update();
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

    function update() {
        var regs = cpu.getRegs();
        $('#af').html(hex16(regs.af()));
        $('#bc').html(hex16(regs.bc()));
        $('#de').html(hex16(regs.de()));
        $('#hl').html(hex16(regs.hl()));
        $('#pc').html(hex16(regs.pc));
        $('#sp').html(hex16(regs.sp));
        $('#flags').html(cpu.getFlagString());
        $('#disassemble').html(cpu.disassemble(regs.pc)[0]);
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
        // this fails to load local files on IE9 with jquery-2.1.0
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
        if (val === 'empty') {
            floppy[unit].removeFloppy();
            ds[0][1].disabled = true;
        } else if (val === 'local') {
            // activate the hidden local file browser control
            di.click();
        } else if (val !== 'prompt') {
            diskRemoteFile(unit, val);
        }
        // change back to "Select a disk..."
        ds[0].selectedIndex = 0;
        ds.blur();
    }

    function diskDump(unit) {
        var text = floppy[unit].getFile();
        if (text !== undefined) {
            if (browserSupports.fileApi) {
                // offer save-as dialog
                var term = text.map(function(elem) { return elem + '\n'; });
                var blob = new Blob(term, {type: 'text/plain',
                                           endings: 'native'});
                saveAs(blob, 'diskimage.ccvf');
            } else {
                // klunky: open window containing the text
                var win = window.open('', 'diskwindow',
                    'width=350,height=350,menubar=1,toolbar=1,status=0,scrollbars=1,resizable=1');
                if (win) {
                    for (var n = 0; n < text.length; n++) {
                        win.document.write(text[n] + '<br/>');
                    }
                    win.document.close();
                }
            }
            // mark the disk is written so we don't pester the user to save
            // the disk on exit
            floppy[unit].setStatus('unmodified');
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
            $('#disksel' + unit)[0][1].disabled = (floppy[unit].getStatus() === 'empty');
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
            $('#disksel' + unit)[0][1].disabled = (floppy[unit].getStatus() === 'empty');
        }, 'text')
         .fail(function (jqXHR, textStatus) {
            alert('File ' + fileURL + ' failed to load! status=' + textStatus);
            $('#disksel' + unit)[0][1].disabled = (floppy[unit].getStatus() === 'empty');
        });
    }

    // (attached to a UI button)
    function run1()
    {
        halt();
        singleStep();
        update();
    }

    // (attached to a UI button)
    function runn()
    {
        halt();
        var n = parseInt($('#nval')[0].value, 10);
        for (var i = 0; i < n; ++i) {
            singleStep();
        }
        update();
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
            ccemu.interval = setInterval(doCpuTimeslice, TIMESLICE_MS);
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

    function setScreenSize(scaling) {
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
            { label: 'Air Raid',        value: 'disks/airraid.ccvf'             },
            { label: 'Alien Invasion',  value: 'disks/alien_invasion_v1.4.ccvf' },
            { label: 'Blackjack',       value: 'disks/blackjack.ccvf'           },
            { label: 'Blank',           value: 'disks/blank.ccvf'               },
            { label: 'Castle Quest',    value: 'disks/chip_33.ccvf'             },
            { label: 'Chess',           value: 'disks/chess.ccvf'               },
            { label: 'Chip #91',        value: 'disks/chip_91.ccvf'             },
            { label: 'Chip #106',       value: 'disks/chip_106.ccvf'            },
            { label: 'Chomp (Pacman)',  value: 'disks/chomp.ccvf'               },
            { label: 'Dev Tools',       value: 'disks/cooltools.ccvf'           },
            { label: 'Hangman',         value: 'disks/hangman.ccvf'             },
            { label: 'Lunar Lander',    value: 'disks/lunar_lander.ccvf'        },
            { label: 'Othello',         value: 'disks/othello.ccvf'             },
            { label: 'Sampler',         value: 'disks/sampler.ccvf'             },
            { label: 'Sharks',          value: 'disks/sharks.ccvf'              },
            { label: 'Startrek',        value: 'disks/startrek.ccvf'            },
            { label: 'Swarms',          value: 'disks/swarms.ccvf'              },
            { label: 'Various Game',    value: 'disks/taylor_games.ccvf'        }
        ];
        var pd = $(id);
        var opttag = '<option></option>';
        pd.append($(opttag).val('prompt').text('Select a disk...'));
        pd.append($(opttag).val('empty').text('--empty--'));
        if (browserSupports.fileApi) {
            pd.append($(opttag).val('local').text('Use local file...'));
        }
        for (var n=0; n<disks.length; n++) {
            pd.append($(opttag).val(disks[n].value).text(disks[n].label));
        }
        pd[0][0].disabled = true;  // "Select a disk..."
        pd[0][1].disabled = true;  // "--empty--"
    }

    // note: all uses are using non-ascii encoding strings,
    //       and when it gets down into encodeASCII, it uses the
    //       ambient values of PC shift&control for the CC versions,
    //       so we don't have to pass them.
    function getVirtualModals() {
        var capslock_state = $('#capslock').hasClass('active');
        var repeat_state   = $('#repeat').hasClass('active');
        var command_state  = $('#command').hasClass('active');
        var ctrl_state     = $('#ctrl').hasClass('active') || command_state;
        var shft_state     = $('#shftlft').hasClass('active') || command_state;
        var keyobj = {
                shft: shft_state,
                ctrl: ctrl_state,
                repeat: repeat_state,
                capslock: capslock_state
            };
        return keyobj;
    }

    function setVirtualKeyModals() {
        var keyobj = getVirtualModals();
        keybrd.virtualKey(keyobj);
    }

    // wire up the virtual keyboard resizing controls based on argument
    function setVirtualKeyboardSize(size) {
        var vkbd      = $('#virtualkeyboard');
        var vkButtons = $('#virtualkeyboard button');
        var vkBig     = $('#virtualkeyboard button span.big');
        var vkBig2    = $('#virtualkeyboard button span.big2');
        switch (size) {
            case 'none':
                vkbd.hide(300);
                break;
            case 'small':
                vkbd.show(300);
                vkbd.css({ 'font-size': '8px' });
                vkButtons.css({ 'font-size': '8px' });
                vkBig2.css({ 'font-size': '9px' });
                vkBig.css({ 'font-size': '11px' });
                break;
            case 'medium':
                vkbd.show(300);
                vkbd.css({ 'font-size': '9px' });
                vkButtons.css({ 'font-size': '9px' });
                vkBig2.css({ 'font-size': '10px' });
                vkBig.css({ 'font-size': '12px' });
                break;
            case 'large':
                vkbd.show(300);
                vkbd.css({ 'font-size': '10px' });
                vkButtons.css({ 'font-size': '10px' });
                vkBig2.css({ 'font-size': '11px' });
                vkBig.css({ 'font-size': '13px' });
                break;
            default:
                alert('param error in setVirtualKeyboardSize()');
                return;
        }

        // if the size is 'none', disable the layout pulldown
        $('#vksel').prop('disabled', size === 'none');
    }

    // set the keyboard size based on the current pulldown selection
    function virtualKeyboardResize() {
        var size = $('#vksize')[0].value;
        setVirtualKeyboardSize(size);
    }

    function bindEvents() {

        // add "Fullscreen" screen size option only if the browser supports it
        if (browserSupports.fullscreen) {
            var e = document.getElementById('canv');
            $('#ssizesel').append('<option value="999">Fullscreen');

            // detect when we exit fullscreen mode so we can set the choice
            // box back to what it was before entering fullscreen mode
            if (document.addEventListener !== undefined) {
                var evn = (e.requestFullScreen)    ? 'fullscreenchange' :
                          (e.mozRequestFullScreen) ? 'mozfullscreenchange' :
                                                     'webkitfullscreenchange';
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
            this.blur();
        });
        $('#warmreset').click(function () {
            warmReset();
            this.blur();
        });
        $('#auto').mousedown(function (evt) {
            if (evt.which === 1) {
                keybrd.virtualKey({key: 'auto'});
                this.blur();
            }
        });
        $('#auto').mouseup(function () {
            keybrd.virtualKey({});
        });
        $('#fileinput').change(autorunLocalFile);
        $('#filesel').change(function () {
            var val = this.value;
            if (val === 'local') {
                // activate the hidden local file browser control
                $('#fileinput').click();
            } else if (val !== 'prompt') {
                autotypeRemoteFile(val);
            }
            this.selectedIndex = 0;
            this.blur();
        });
        function make_diskInputHandler(n) { return function () { diskInput(n); }; }
        function make_diskPickHandler(n)  { return function () { diskPick(n);  }; }
        function make_diskSaveHandler(n)  {
            return function (evt) {
                if ((navigator.platform === 'MacIntel' && evt.altKey) ||
                    (navigator.platform !== 'MacIntel' && evt.ctrlKey)) {
                    diskDump(n);
                }
            };
        }
        for (var n = 0; n < numFloppies; n++) {
            $('#diskinput' + n).change(make_diskInputHandler(n));
            $('#disksel' + n).change(make_diskPickHandler(n));
            $('#drive' + n).click(make_diskSaveHandler(n));
        }
        $('#ssizesel').change(function () {
            var val = this.value;
            setScreenSize(val);
            store.set('screenSize', val);
        });
        $('#chsetsel').change(function () {
            var index = this.selectedIndex;
            setCharacterset(index);
            store.set('charGenerator', ['standard', 'lower'][index]);
        });
        $('#romsel').change(function () {
            var name = this.value;
            setROMVersion(name);
            store.set('romVersion', name);
            ccemu.hardReset();
            // take the focus off the control, otherwise subsequent
            // keyboard events can activate it inadvertently
            this.blur();
        });
        if (browserSupports.audio) {
            $('#soundware_cb').click(function () {
                audio.enable(this.checked);
                store.set('soundware', this.checked ? 'enabled' : 'disabled');
            });
        }
        if (show_speed_regulation) {
            // because the contents of the div, including the checkbox,
            // are regenerated every second, we can't just attach the
            // event handler on the checkbox (without having to rewire the
            // callback every time).  So catch the event in the parent.
            $('div.regulate').click(function (evt) {
                var target = evt.target || evt.srcElement;
                if (target.id === 'regulate_cb') {
                    regulated_cpu = target.checked;
                }
            });
        }
        $('#run_debug').click(function () {
            runOrDebug('toggle');
            $('#run_debug').blur();
        });
        $('#run1').click(run1);
        $('#runn').click(runn);

        $('#vksize').change(function () {
            var size = this.value;
            setVirtualKeyboardSize(size);
            store.set('vkSize', size);
            this.blur();  // remove focus
        });

        $('#vksel').change(function () {
            var index = this.selectedIndex;  // 0-2
            buildVirtualKeyboard(index + 1);
            virtualKeyboardResize();
            store.set('vkLayout', ['basic', 'enhanced', 'deluxe'][index]);
        });

        // have the div containing the virtual keys catch and delegate events,
        // rather than attaching event handlers to each key
        var vk = document.getElementById('virtualkeyboard');
        vk.onmousedown = function (evt) {
            var target = evt.target || evt.srcElement;
            var encoding;
            if (target.dataset === undefined) {
                // IE9, IE10
                encoding = target.getAttribute('data-keyval');
            } else {
                // assume dataset works
                // On Chrome, if the text region of a button is clicked, the
                // target we get here is the text span, not the button, so the
                // data attribute is missing.  to compensate, if there is no
                // keyval, check if the parent has a keyval.
                encoding = (target.dataset.keyval === undefined) ?
                               target.parentNode.dataset.keyval :
                               target.dataset.keyval;
            }
            if (encoding === undefined) {
                return;
            }
            if (encoding === 'capslock' ||
                encoding === 'command' ||
                encoding === 'repeat') {
                $('button#' + encoding).toggleClass('active');
            }
            if (encoding === 'shft') {
                $('button#shftlft').toggleClass('active');
                $('button#shftrgt').toggleClass('active');
            }
            if (encoding === 'ctrl') {
                $('button#ctrl').toggleClass('active');
            }
            var keyobj = getVirtualModals();
            if (encoding === 'cpurst') {
                if (keyobj.ctrl && keyobj.shft) {
                    ccemu.hardReset();
                } else {
                    ccemu.warmReset();
                }
                return;
            }
            if (encoding !== 'command') {  // command is really shift+ctrl
                keyobj.key = encoding;
            }
            keybrd.virtualKey(keyobj);
        };
        vk.onmouseup = setVirtualKeyModals;
        vk.onmouseleave = setVirtualKeyModals;

        // warn if leaving the page when there is modified disk state
        // http://stackoverflow.com/questions/1704533/intercept-page-exit-event
        //
        // Note: Firefox doesn't display the supplied message because they view
        //       it as a security issue.  Otherwise, ads on a webpage can
        //       inject misleading text into a browser dialog, vs. having just
        //       the standard neutral message.
        window.onbeforeunload = function (e) {
            e = e || window.event;
            var disk0_modified = (floppy[0].getStatus() === 'modified');
            var disk1_modified = (floppy[1].getStatus() === 'modified');
            var message = (disk0_modified && disk1_modified) ?
                "Disks in drives CD0: and CD1: have been modified; are you sure you want to exit?" :
                          (disk0_modified) ?
                "Disk in drive CD0: has been modified; are you sure you want to exit?" :
                          (disk1_modified) ?
                "Disk in drive CD1: has been modified; are you sure you want to exit?" :
                undefined;
            if (message) {
                // For IE
                if (e) {
                    e.returnValue = message;
                }
                // For Safari
                return message;
            }
        };

    } // bindEvents()

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

        // audio api
        browserSupports.audio = window.hasOwnProperty('AudioContext');

        // blob
        try {
            browserSupports.blob = !!new Blob();
        } catch (e) {
            browserSupports.blob = false;
        }

        // localstorage
        browserSupports.localstore = store.enabled;
        if (!browserSupports.localstore) {
            alert('Local storage is not supported -- prefs not persistent');
        }
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
            alert('ERROR: setROMVersion called with ' + name);
            name = 'v6.78';
            system_rom = system_rom_6_78;
            stepper_phases = 3;
        }

        if (system_rom === cur_system_rom) {
            // nothing has changed
            return;
        }

        for (var i = 0; i < system_rom.length; ++i) {
            wrUnsafe(i, system_rom[i]);
        }

        // the floppy stepper type is tied to the ROM version
        floppy.forEach(function(elem) {
            elem.setStepperPhases(stepper_phases);
        });

        // set index in pulldown
        $('#romsel').val(name);
    }

    // from http://stackoverflow.com/questions/901115/how-can-i-get-query-string-values-in-javascript
    function getParameterByName(name) {
        name = name.replace(/[\[]/, "\\[").replace(/[\]]/, "\\]");
        var regex = new RegExp("[\\?&]" + name + "=([^&#]*)"),
            results = regex.exec(location.search);
        return results === null ? "" : decodeURIComponent(results[1].replace(/\+/g, " "));
    }

    // 1=standard, 2=enhanced, 3=deluxe
    function buildVirtualKeyboard(kb_model) {
        // format:
        //    - a list of rows
        //      - each row contains a list of key descriptions
        //        - each key description contains a dict of
        //            + the keyboard model number where this key is used
        //            + the key value sent to the button handler
        //            + label     (the primary key label)
        //            + label2    (the label above the primary label)
        //            + style     (the css class)
        //            + width     (button or spacer width)
        var kbtable = [
            // row 0: function keys
            [
                { model: 3, key: 'F0',    id: 'F0',    label2: 'F0',  label: 'VECT|INC',   style: 'fcn'    },
                { model: 3, key: 'F1',    id: 'F1',    label2: 'F1',  label: 'VECT|Y1',    style: 'fcn'    },
                { model: 3, key: 'F2',    id: 'F2',    label2: 'F2',  label: 'VECT|X1',    style: 'fcn'    },
                { model: 3, key: 'F3',    id: 'F3',    label2: 'F3',  label: 'Y BAR|INC',  style: 'fcn'    },
                { model: 3, key: 'F4',    id: 'F4',    label2: 'F4',  label: 'Y BAR|YM',   style: 'fcn'    },
                { model: 3, key: 'F5',    id: 'F5',    label2: 'F5',  label: 'Y BAR|X',    style: 'fcn'    },
                { model: 3, key: 'F6',    id: 'F6',    label2: 'F6',  label: 'Y BAR|Y0',   style: 'fcn'    },
                { model: 3, key: 'F7',    id: 'F7',    label2: 'F7',  label: 'X BAR|INC',  style: 'fcn'    },
                { model: 3, key: 'F8',    id: 'F8',    label2: 'F8',  label: 'X BAR|XM',   style: 'fcn'    },
                { model: 3, key: 'F9',    id: 'F9',    label2: 'F9',  label: 'X BAR|Y',    style: 'fcn'    },
                { model: 3, key: 'F10',   id: 'F10',   label2: 'F10', label: 'X BAR|0',    style: 'fcn'    },
                { model: 3, key: 'F11',   id: 'F11',   label2: 'F11', label: 'POINT|INC',  style: 'fcn'    },
                { model: 3, key: 'F12',   id: 'F12',   label2: 'F12', label: 'POINT|Y',    style: 'fcn'    },
                { model: 3, key: 'F13',   id: 'F13',   label2: 'F13', label: 'POINT|X',    style: 'fcn'    },
                { model: 3, key: 'F14',   id: 'F14',   label2: 'F14', label: 'CHAR|PLOT',  style: 'fcn'    },
                { model: 1, key: 'curup', id: 'up',                   label: '&uarr;',     style: 'arrow'  },
                { model: 3, key: 'F15',   id: 'F15',   label2: 'F15', label: 'PLOT|ESC',   style: 'fcn'    },
                {                                                                          style: 'spacer' },
                { model: 1, key: 'epage', id: 'epage',                label: 'ERASE|PAGE', style: 'rstrow' },
                { model: 1, key: 'eline', id: 'eline',                label: 'ERASE|LINE', style: 'rstrow' },
                {                                                                          style: 'spacer' },
                { model: 1, key: 'cpurst', id: 'cpurst',              label: 'CPU|RESET',  style: 'rstrow' }
            ],

            // row 1: more function keys
            [
                {                                                                                        style: 'spacer', width: 3.0 },
                { model: 1, key: 'auto',    id: 'autok',                           label: 'AUTO'                                     },
                { model: 1, key: 'fgon',    id: 'fgon',    label2: 'FG ON',        label: 'FLG OFF'                                  },
                { model: 1, key: 'bgon',    id: 'bgon',    label2: 'BG ON',        label: 'FLG ON'                                   },
                { model: 1, key: 'blinkon', id: 'blnkon',                          label: 'BLINK|ON'                                 },
                { model: 1, key: 'bla7off', id: 'bla7off',                         label: 'BL/A7|OFF'                                },
                { model: 1, key: 'a7on',    id: 'a7on',                            label: 'A7|ON'                                    },
                { model: 1, key: '[',       id: 'vis',     label2: 'VIS',          label: '['                                        },
                { model: 1, key: '\\',      id: 'upa',     label2: '45 UP|&uarr;', label: '\\'                                       },
                { model: 1, key: ']',       id: 'block',   label2: 'BLCK',         label: ']'                                        },
                { model: 1, key: '^',       id: 'user',    label2: 'USER',         label: '^'                                        },
                { model: 1, key: '_',       id: 'crt',     label2: 'CRT',          label: '_'                                        },
                { model: 1, key: 'curlft',  id: 'left',                            label: '&larr;',      style: 'arrow'              },
                { model: 1, key: 'home',    id: 'home',                            label: 'HOME',        style: 'arrow'              },
                { model: 1, key: 'currgt',  id: 'right',                           label: '&rarr;',      style: 'arrow'              },
                {                                                                                        style: 'spacer'             },
                { model: 2, key: 'delchar', id: 'delchar',                         label: 'DELETE|CHAR'                              },
                { model: 2, key: 'inschar', id: 'inschar',                         label: 'INSERT|CHAR'                              },
                { model: 2, key: 'delline', id: 'delline',                         label: 'DELETE|LINE'                              },
                { model: 2, key: 'insline', id: 'insline',                         label: 'INSERT|LINE'                              }
            ],

            // row 2: numbers
            [
                { model: 2, key: 'black',  id: 'black',                  label: '[OUT]',  style: 'black'  },
                { model: 2, key: 'blue',   id: 'blue',                   label: '[LOAD]', style: 'blue'   },
                {                                                                         style: 'spacer' },
                { model: 1, key: 'esc',    id: 'esc',                    label: 'ESC'                     },
                { model: 1, key: '1',      id: 'n1',    label2: '!',     label: '1'                       },
                { model: 1, key: '2',      id: 'n2',    label2: '"',     label: '2'                       },
                { model: 1, key: '3',      id: 'n3',    label2: '#',     label: '3'                       },
                { model: 1, key: '4',      id: 'n4',    label2: '$',     label: '4'                       },
                { model: 1, key: '5',      id: 'n5',    label2: '%',     label: '5'                       },
                { model: 1, key: '6',      id: 'n6',    label2: '&amp;', label: '6'                       },
                { model: 1, key: '7',      id: 'n7',    label2: "'",     label: '7'                       },
                { model: 1, key: '8',      id: 'n8',    label2: '(',     label: '8'                       },
                { model: 1, key: '9',      id: 'n9',    label2: ')',     label: '9'                       },
                { model: 1, key: '0',      id: 'n0',                     label: '0'                       },
                { model: 1, key: '-',      id: 'minus', label2: '=',     label: '-'                       },
                { model: 1, key: 'curdwn', id: 'down',                   label: '&darr;', style: 'arrow'  },
                { model: 1, key: 'break',  id: 'break', label2: 'ATTN',  label: 'BREAK'                   }
            ],

            // row 3: QUERTY
            [
                { model: 2, key: 'red',     id: 'red',                            label: '[PUT]',  style: 'red'                 },
                { model: 2, key: 'magenta', id: 'magenta',                        label: '[POKE]', style: 'magenta'             },
                {                                                                                  style: 'spacer'              },
                { model: 1, key: 'tab',     id: 'tab',                            label: 'TAB',                     width: 1.40 },
                { model: 1, key: 'Q',       id: 'cQ',     label2: '(INS|CHAR)',   label: 'Q',      style: 'red'                 },
                { model: 1, key: 'W',       id: 'cW',     label2: '(BASIC)| ',    label: 'W',      style: 'white'               },
                { model: 1, key: 'E',       id: 'cE',     label2: '(BSC|RST)',    label: 'E'                                    },
                { model: 1, key: 'R',       id: 'cR',     label2: '(BAUD|RATE)',  label: 'R',      style: 'green'               },
                { model: 1, key: 'T',       id: 'cT',     label2: '(TEXT|EDIT)',  label: 'T',      style: 'blue'                },
                { model: 1, key: 'Y',       id: 'cY',     label2: '(TEST)| ',     label: 'Y'                                    },
                { model: 1, key: 'U',       id: 'cU',     label2: '(INS|LINE)',   label: 'U',      style: 'magenta'             },
                { model: 1, key: 'I',       id: 'cI',     label2: ' | ',          label: 'I'                                    },
                { model: 1, key: 'O',       id: 'cO',     label2: ' | ',          label: 'O'                                    },
                { model: 1, key: 'P',       id: 'cP',     label2: '(CPU|OP SYS)', label: 'P',      style: 'black'               },
                { model: 1, key: '@',       id: 'cat',    label2: 'NULL| ',       label: '@'                                    },
                { model: 1, key: 'cr',      id: 'return',                         label: 'RETURN', style: 'return', width: 1.40 },
                {                                                                                  style: 'spacer', width: 1.25 },
                { model: 2, key: 'num7',    id: 'nk7',                            label: '7',      style: 'nkgreen'             },
                { model: 2, key: 'num8',    id: 'nk8',                            label: '8',      style: 'nkgreen'             },
                { model: 2, key: 'num9',    id: 'nk9',                            label: '9',      style: 'nkgreen'             },
                { model: 2, key: 'num/',    id: 'nkdiv',                          label: '/'                                    }
            ],

            // row 4: ASDF
            [
                { model: 2, key: 'green', id: 'green',                          label: '[PLOT]',  style: 'green'               },
                { model: 2, key: 'cyan',  id: 'cyan',                           label: '[PRINT]', style: 'cyan'                },
                {                                                                                 style: 'spacer', width: 1.25 },
                { model: 1, key: 'ctrl',  id: 'ctrl',                           label: 'CONTROL',                  width: 1.40 },
                { model: 1, key: 'A',     id: 'cA',      label2: 'PROT|(BLND)', label: 'A'                                     },
                { model: 1, key: 'S',     id: 'cS',      label2: '(ASMB)| ',    label: 'S',       style: 'yellow'              },
                { model: 1, key: 'D',     id: 'cD',      label2: '(DISK|FCS)',  label: 'D'                                     },
                { model: 1, key: 'F',     id: 'cF',      label2: ' | ',         label: 'F'                                     },
                { model: 1, key: 'G',     id: 'cG',      label2: 'BELL| ',      label: 'G'                                     },
                { model: 1, key: 'H',     id: 'cH',      label2: '(HALF)| ',    label: 'H'                                     },
                { model: 1, key: 'J',     id: 'cJ',      label2: ' | ',         label: 'J'                                     },
                { model: 1, key: 'K',     id: 'cK',      label2: '(ROLL)| ',    label: 'K'                                     },
                { model: 1, key: 'L',     id: 'cL',      label2: '(LOCL)| ',    label: 'L'                                     },
                { model: 1, key: ';',     id: 'semi',    label2: '+',           label: ';'                                     },
                { model: 1, key: ':',     id: 'colon',   label2: '*',           label: ':'                                     },
                {                                                                                 style: 'spacer', width: 2.40 },
                { model: 2, key: 'num4',  id: 'nk4',                            label: '4',       style: 'nkgreen'             },
                { model: 2, key: 'num5',  id: 'nk5',                            label: '5',       style: 'nkgreen'             },
                { model: 2, key: 'num6',  id: 'nk6',                            label: '6',       style: 'nkgreen'             },
                { model: 2, key: 'num*',  id: 'nkmult',                         label: '*'                                     }
            ],

            // row 5: ZXCV
            [
                { model: 2, key: 'yellow', id: 'yellow',                         label: '[SAVE]',  style: 'yellow'              },
                { model: 2, key: 'white',  id: 'white',                          label: '[LIST]',  style: 'white'               },
                {                                                                                  style: 'spacer', width: 1.75 },
                { model: 1, key: 'shft',   id: 'shftlft',                        label: 'SHIFT',                    width: 1.40 },
                { model: 1, key: 'Z',      id: 'cZ',      label2: '(45 DW)| ',   label: 'Z'                                     },
                { model: 1, key: 'X',      id: 'cX',      label2: 'XMIT| ',      label: 'X'                                     },
                { model: 1, key: 'C',      id: 'cC',      label2: 'CURSOR|X-Y',  label: 'C'                                     },
                { model: 1, key: 'V',      id: 'cV',      label2: '(DEL|LINE)',  label: 'V',       style: 'cyan'                },
                { model: 1, key: 'B',      id: 'cB',      label2: 'PLOT| ',      label: 'B'                                     },
                { model: 1, key: 'N',      id: 'cN',      label2: ' | ',         label: 'N'                                     },
                { model: 1, key: 'M',      id: 'cM',      label2: '(TERM|MODE)', label: 'M'                                     },
                { model: 1, key: ',',      id: 'comma',   label2: '<',           label: ','                                     },
                { model: 1, key: '.',      id: 'period',  label2: '>',           label: '.'                                     },
                { model: 1, key: '/',      id: 'slash',   label2: '?',           label: '/'                                     },
                { model: 1, key: 'shft',   id: 'shftrgt',                        label: 'SHIFT',                    width: 1.40 },
                {                                                                                  style: 'spacer', width: 1.50 },
                { model: 2, key: 'num1',   id: 'nk1',                            label: '1',       style: 'nkgreen'             },
                { model: 2, key: 'num2',   id: 'nk2',                            label: '2',       style: 'nkgreen'             },
                { model: 2, key: 'num3',   id: 'nk3',                            label: '3',       style: 'nkgreen'             },
                { model: 2, key: 'num-',   id: 'nksub',                          label: '-'                                     }
            ],

            // row 6: spacebar row
            [
                { model: 2, key: 'command',  id: 'command',  label: '[COMMAND]',                  width: 2.0  },
                {                                                                style: 'spacer', width: 3.15 },
                { model: 1, key: 'capslock', id: 'capslock', label: 'CAPS|LOCK'                               },
                { model: 1, key: ' ',        id: 'spacebar', label: '',                           width: 8.0  },
                { model: 1, key: 'repeat',   id: 'repeat',   label: 'REPEAT'                                  },
                {                                                                style: 'spacer', width: 2.90 },
                { model: 2, key: 'num0',     id: 'nk0',      label: '0',         style: 'nkgreen'             },
                { model: 2, key: 'num.',     id: 'nkdot',    label: '.'                                       },
                { model: 2, key: 'num=',     id: 'nkeq',     label: '='                                       },
                { model: 2, key: 'num+',     id: 'nkplus',   label: '+'                                       }
            ]
        ];

        // put a span class wrapper around keys which should be in a larger font
        // class "big" is for single letter primary labels (eg, 'A')
        // class "big2" is for multi-letter primary labels (eg, 'HOME')
        function bigger_label(label) {
            var bigones = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
                          '0123456789' +
                          '!"#$%&\'(),<.>*/?;:=+-@[]^\\_';
            var others = { '&amp;': 1,
                           '&uarrow': 1, '&darrow': 1, '&larrow': 1, '&rarrow': 1 };
            var others2 = { '&uarrow': 1, '&darrow': 1, '&larrow': 1, '&rarrow': 1,
                            'TAB': 1, 'ESC': 1, 'HOME': 1, 'RETURN': 1,
                            'AUTO': 1, 'SHIFT': 1, 'CONTROL': 1,
                            '[OUT]': 1, '[LOAD]': 1,
                            '[PUT]': 1, '[POKE]': 1,
                            '[PLOT]': 1, '[PRINT]': 1,
                            '[SAVE]': 1, '[LIST]': 1,
                            '[COMMAND]': 1 };
            var big = ((label.length === 1) & (bigones.indexOf(label) >= 0)) ||
                      others[label];
            var big2 = others2[label];
            return (big)  ? ('<span class="big">' + label + '</span>') :
                   (big2) ? ('<span class="big2">' + label + '</span>') :
                            label;
        }

        var scale_em = 5.5;

        // generate the virtual keyboard.
        // we can't use a table because the keys of each row don't line up, so instead we have
        // a div and fill it with absolutely positioned buttons.
        var fragment = document.createDocumentFragment(),
            thisdiv = document.createElement('div'),
            max_width = 0;

        fragment.appendChild(thisdiv);

        var row, kbitem, kbitemidx, kbrowlen;
        var pos_y = 0;
        for (row=0; row < kbtable.length; row++) {
            var pos_x = (kb_model === 1) ? -3 : 0;  // left three columns of keys are all empty
            for(kbitemidx=0, kbrowlen = kbtable[row].length; kbitemidx < kbrowlen; kbitemidx++) {

                kbitem = kbtable[row][kbitemidx];
                var style = (kbitem.model <= kb_model) ? kbitem.style : 'spacer';
                var thisbut = (style === 'spacer') ? document.createElement('div')
                                                   : document.createElement('button');

                var label = "";
                if (kbitem.label2 !== undefined) {
                    label = kbitem.label2.replace(/ /g, '&nbsp;');
                    label = bigger_label(label);
                    label = label.replace(/\|/g, ' <br /> ');
                }
                if (kbitem.label !== undefined) {
                    if (label) {
                        // separate shifted legend from unshifted legend
                        label += ' <br /> ';
                    }
                    var label_tmp = kbitem.label.replace(/ /g, '&nbsp;');
                    label_tmp = bigger_label(label_tmp);
                    label += label_tmp.replace(/\|/, ' <br /> ');
                }
                label = (style === 'spacer') ? '' : label;

                thisbut.id = kbitem.id;
                thisbut.innerHTML = label;
                thisbut.className = kbitem.style || 'norm';
                thisbut.style.width = (scale_em * (kbitem.width || 1.0)) + 'em';
                thisbut.style.position = 'absolute';  // relative to containing div
                thisbut.style.left = (scale_em * pos_x) + 'em';
                thisbut.style.top  = (scale_em * pos_y) + 'em';
                if (kbitem.key !== undefined) {
                    if (thisbut.dataset === undefined) {
                        // IE9, IE10
                        thisbut.setAttribute('data-keyval', kbitem.key);
                    } else {
                        // assume dataset is supported
                        thisbut.dataset.keyval = kbitem.key;
                    }
                }
                thisdiv.appendChild(thisbut);

                pos_x += (kbitem.width || 1.0);
            } // for kbitemidx

            max_width = (pos_x > max_width) ? pos_x : max_width;
            pos_y += 1;
        } // for row

        thisdiv.style.position = 'relative';
        thisdiv.style.width  = (scale_em * (max_width + 0.5)) + 'em';
        thisdiv.style.height = (scale_em * (pos_y + 0.5)) + 'em';
        thisdiv.style.marginLeft = thisdiv.style.marginRight = 'auto';  // centered

        // inject the keyboard into the wrapper div
        var vkdiv = document.getElementById('virtualkeyboard');
        var old = vkdiv.firstElementChild;
        if (old) {
            vkdiv.replaceChild(fragment, old);
        } else {
            vkdiv.appendChild(fragment);
        }
    }

    // set default configuration choices
    function setDefaultConfig() {
        $('#ssizesel').val('1.00');
        $('#chsetsel').val('Standard');
        $('#romsel').val('v6.78');
        setROMVersion('v6.78');
        $('#soundware_cb').prop('checked', false);
        $('#regulate_cb').prop('checked', regulated_cpu);
        $('#vkNone').prop('checked', true);
        $('#vksel').val('Deluxe');
        buildVirtualKeyboard(3); // full keyboard, by default

        $('#filesel').val('prompt');
        for (var i = 0; i < numFloppies; i++) {
            $('#disksel' + i).val('prompt');
        }
    }

    // apply preferences
    function applyPreferences() {
        var pref_romVersion = store.get('romVersion'),    // v6.78 or v8.79
            pref_screenSize = store.get('screenSize'),    // 1.00, 1.25, etc
            pref_charGen    = store.get('charGenerator'), // 'standard', 'lower'
            pref_soundware  = store.get('soundware'),     // 'enabled', 'disabled'
            pref_vkSize     = store.get('vkSize'),        // 'none', 'small', 'medium', 'large'
            pref_vkLayout   = store.get('vkLayout');      // 'basic', 'enhanced', 'deluxe'

        if (pref_romVersion) {
            setROMVersion(pref_romVersion);
        }
        if (pref_screenSize) {
            setScreenSize(pref_screenSize);
            // set index in pulldown
            $('#ssizesel').val(pref_screenSize);
        }
        if (pref_charGen) {
            var chset_idx = {'standard': 0, 'lower': 1}[pref_charGen];
            var chset_val = ['Standard', 'Lower case'][chset_idx];
            setCharacterset(chset_idx);
            $('#chsetsel').val(chset_val);
        }
        if (pref_soundware) {
            var soundware_enabled = (pref_soundware === 'enabled');
            $('#soundware_cb').prop('checked', soundware_enabled);
            audio.enable(soundware_enabled);
        }
        if (pref_vkSize) {
            $('#vksize').val(pref_vkSize);
            virtualKeyboardResize();
        }
        if (pref_vkLayout) {
            var val, index;
            switch (pref_vkLayout) {
                case 'basic':
                    val = 'Basic';
                    index = 1;
                    break;
                case 'enhanced':
                    val = 'Enhanced';
                    index = 2;
                    break;
                case 'deluxe':
                    val = 'Deluxe';
                    index = 3;
                    break;
                default:
                    val = 'Deluxe';
                    index = 3;
                    break;
            }
            buildVirtualKeyboard(index);
            $('#vksel').val(val);
            virtualKeyboardResize(); // this is needed to reset size
        }
    }

    function applyUrlSettings() {
        // see if a boot conditions were specified in URL
        var url_cd0 = getParameterByName('cd0');
        var url_cd1 = getParameterByName('cd1');
        var url_rom = getParameterByName('rom');
        var url_auto = getParameterByName('auto');

        if (url_cd0 && url_cd0.match(/\.ccvf$/)) {
            diskRemoteFile(0, url_cd0);
        }
        if (url_cd1 && url_cd1.match(/\.ccvf$/)) {
            diskRemoteFile(1, url_cd1);
        }

        // this overrides prefs
        if ((url_rom === 'v6.78') || (url_rom === 'v8.79')) {
            setROMVersion(url_rom);
        } else if (url_rom !== '') {
            alert('Bad ROM version specified; using v6.78');
            setROMVersion('v6.78');
        }

        if (url_auto === '1') {
            scheduler.oneShot( Math.floor(3.0*CPU_FREQ),
                    function () { keybrd.virtualKey({ key: 'auto' }); },
                    'autotimer');
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

        var cbIntVec = tms5501.getIntVector;  // interrupt vector callback
        cpu = new Cpu(ram, rd, wr, input, output, cbIntVec);
        for (i = 0; i < numFloppies; i++) {
            floppy.push(new Floppy(i));
        }
        crt.init();
        smc5027.init();

        // set up period events -- return objects are ignored because they
        // are never canceled
        var displayPeriod = Math.floor(CPU_FREQ / 30);
        var tms5501Period = Math.floor(CPU_FREQ * 64 / 1000000);
        scheduler.periodic(displayPeriod, function () { crt.vsync(); }, 'display');
        scheduler.periodic(tms5501Period, function () { tms5501.tick64us(); }, '5501');

        // set up the pulldown lists
        populateFilePulldown('#filesel');
        for (i = 0; i < numFloppies; i++) {
            populateFloppyPulldown('#disksel' + i);
        }

        // connect functions up to html elements
        bindEvents();

        // show it only if it is supported
        if (browserSupports.audio) {
            $('.soundware').show();
        }

        if (show_speed_regulation) {
            $('.regulate').show();
        }

        // optional ROM version interface
        if (enable_rom_selection) {
            $('.romdiv').show();
        } else {
            $('.romdiv').hide();
        }

        // optional debug interface
        if (enable_debug_interface) {
            $('#run_debug').show();
        } else {
            $('#run_debug').hide();
        }

        // configure the options
        setDefaultConfig();
        applyPreferences();
        applyUrlSettings();

        updateScreenPlacement();

        hardReset();
        runOrDebug('run');

        // update statistics once per second
        setInterval(updateStats, 1000);

        // for unknown reasons, jquery some time after 1.9.1 started forcing
        // 'display: inline-block' on the #nval element, overriding the css
        // specified default 'display: none'.  fight back.
        $('#nval').css('display', 'none');
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
        'audioBoostCpu': audioBoostCpu,
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
