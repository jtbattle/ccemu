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
// keyboard mapping
//============================================================================

// Problem #1:
//
//    Browsers are inconsistent in their encoding of key events, both
//    keydown and keypress.  See http://unixpapa.com/js/key.html or
//    google a bit to find more.
//
//    The approach here is to use keypress for the key combinations where it
//    is reliable, and then use keydown for everything else.  The reliable
//    keys are:
//        a-z, shift a-z
//        0-9, shift 0-9  (what these map to depends on the keyboard!)
//    Everything else is handled by keydown.  Note that the keydown event
//    happens before the keypress event, and in some browsers (IE, webkit)
//    canceling the default keydown behavior cancels the subsequent keypress.
//
// Problem #2:
//
//    The compucolor keyboard has a very different layout from a standard
//    PC, and has many compucolor-specific keys.  The PC has some keys that
//    don't have a natural mapping to the compucolor.  Also, "=" is a shifted
//    key on the compucolor but not on a standard US PC keyboard, so we
//    sometimes have to lie and override those modifier keys.
//
// Problem #3:
//
//    The compucolor has a number of keys that don't have a PC equivalent,
//    eg, the "repeat" key, the "erase page" and "erase line" keys, "AUTO",
//    "BLINK ON", "BL/A7 OFF", "A7 ON", etc.
//
//    Not all keys are available with lower end compucolor machines, so
//    part of the solution is to ignore the ones we can, but there are
//    still many that aren't easily mapped.  We could artificially map
//    some of them to unique PC keyboard keys, like "PAUSE/BREAK", but
//    that is hard for the user to deal with.  So probably the best
//    solution is to graphically present those keys and allow the user
//    to hit them with the mouse button.
//
// Rather than polling the keyboard state every time the emulated CPU
// accesses an I/O port, instead every time there is a PC key up/down
// event, we note it and then translate that to the 17 rows of CC-II
// keyboard state.

// option flags for jslint:
/* global alert */
/* global ccemu, autotyper */

var keybrd = (function () {

    'use strict';

    // choose how to emulate the cc-II "repeat" key.
    // this is not exposed in order to simplify the UI.
    var repeatMode = ['none', 'auto', 'alt'][1];

    // encoded CC-II keyboard matrix state
    // [16] corresponds to the special decode for shift/control/repeat/capslock
    var kbMatrix = [];

    // which PC keys are currently held down
    var ksh = 256;          // keyboard shift encoding
    var isDown = [];        // true if we think this key is currently depressed
    var prevKeydown;        // most recently seen keydown keyCode
    var pcKey = [];         // map event keycode to logical meaning
    var ccKey = {};         // map meaning to compucolor encoding
    var asciiToCcKey = [];  // map ascii values to cc key + modifiers
    var modalKeys = {};     // names for the modifier keys
    var useKeypress = [];

    function buildTables() {

        // don't complain that (e.g.) ccKey["A"] should be ccKey.A
        /* jshint sub: true */

        // unfortunately, ff uses different keyevent numbering than
        // all the other browsers for a few keys.  so we sniff.
        var ff = /firefox/i.test(navigator.userAgent);

        // ----- make a table of which keys we should use keypress;
        //       the rest are handled by keydown.  thankfully, the event
        //       codes for these characters match their ascii values.

        var keypressKeys = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
                           '0123456789';
        for (var n = 0; n < keypressKeys.length; n++) {
            useKeypress[keypressKeys.charCodeAt(n)] = true;
        }

        // ----- map javascript event keycode key meaning

        modalKeys = {
            'shft': true,
            'ctrl': true,
            'alt': true,
            'capslock': true
        };

        // modal keys
        pcKey[ 16] = 'shft';
        pcKey[ 17] = 'ctrl';
        pcKey[ 18] = 'alt';
        pcKey[ 20] = 'capslock';

        // various non-textual characters
        pcKey[  8] = 'bksp';   // backspace
        pcKey[  9] = 'tab';    // tab
        pcKey[ 13] = 'cr';     // carriage return
        pcKey[ 27] = 'esc';    // escape
        pcKey[ 32] = ' ';
        pcKey[ 36] = 'home';
        pcKey[ 37] = 'curlft';
        pcKey[ 38] = 'curup';
        pcKey[ 39] = 'currgt';
        pcKey[ 40] = 'curdwn';

//      pcKey[  3] = 'reset';  // pause/break + ctrl
//      pcKey[ 19] = 'reset';  // pause/break
        pcKey[  3] = 'break';  // pause/break + ctrl
        pcKey[ 19] = 'break';  // pause/break

        // keys on the PC keyboard that don't have a natural mapping
        // to the CC-II.
    //  pcKey[      33] = "pgup";
    //  pcKey[      34] = "pgdn";
        pcKey[      35] = 'break';       // END key
    //  pcKey[      44] = "prntscrn";
        pcKey[      45] = "insert";
        pcKey[      46] = "delete";
    //  pcKey[     144] = "numlock";
    //  pcKey[     145] = "scrolllock";

        pcKey[     112] = 'F1';
        pcKey[     113] = 'F2';
        pcKey[     114] = 'F3';
        pcKey[     115] = 'F4';
        pcKey[     116] = 'F5';
        pcKey[     117] = 'F6';
        pcKey[     118] = 'F7';
        pcKey[     119] = 'F8';
        pcKey[     120] = 'F9';
        pcKey[     121] = 'F10';
        pcKey[     122] = 'F11';
        pcKey[     123] = 'F12';

        pcKey[      188] = ',';
        pcKey[ksh + 188] = '<';
        pcKey[      190] = '.';
        pcKey[ksh + 190] = '>';
        pcKey[      191] = '/';
        pcKey[ksh + 191] = '?';
    //  pcKey[      192] = "`";
    //  pcKey[ksh + 192] = "~";
        pcKey[      219] = '[';
    //  pcKey[ksh + 219] = "{";
        pcKey[      220] = '\\';
    //  pcKey[ksh + 220] = "|";
        pcKey[      221] = ']';
    //  pcKey[ksh + 221] = "}";
        pcKey[      222] = "'";
        pcKey[ksh + 222] = '"';

        // numeric keypad
        pcKey[  96] = 'num0';
        pcKey[  97] = 'num1';
        pcKey[  98] = 'num2';
        pcKey[  99] = 'num3';
        pcKey[ 100] = 'num4';
        pcKey[ 101] = 'num5';
        pcKey[ 102] = 'num6';
        pcKey[ 103] = 'num7';
        pcKey[ 104] = 'num8';
        pcKey[ 105] = 'num9';
        pcKey[ 107] = 'num+';
        pcKey[ 109] = 'num-';
        pcKey[ 106] = 'num*';
        pcKey[ 111] = 'num/';
        pcKey[ 110] = 'num.';

        if (ff) {
            pcKey[       59] = ';';
            pcKey[ksh +  59] = ':';
            pcKey[       61] = '=';
            pcKey[ksh +  61] = '+';
            pcKey[      173] = '-';
            pcKey[ksh + 173] = '_';
        //  pcKey[       91] = "winkey";
        //  pcKey[       93] = "winmenu";
        } else {
            pcKey[      186] = ';';
            pcKey[ksh + 186] = ':';
            pcKey[      187] = '=';
            pcKey[ksh + 187] = '+';
            pcKey[      189] = '-';
            pcKey[ksh + 189] = '_';
        }

        // ----- map 256 ascii values to a corrresponding compucolor
        //       key combination
        // this was taken from Colorcue Vol 4, No 4, p. 18
        // however, for A-Z, the table presupposes Caps Lock is active,
        // so for those keys, the SHIFT state has to be inverted
        var a;
        for (a=0; a<32; a++) {
            asciiToCcKey[a] = {
                key: "@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_".charAt(a),
                ctrl:1
            };
        }
        for (a=32; a<44; a++) {
            asciiToCcKey[a] = { key: "0123456789:;".charAt(a-32), shft:1 };
        }
        for (a=44; a<60; a++) {
            asciiToCcKey[a] = { key: ",-./0123456789:;".charAt(a-44) };
        }
        for (a=60; a<64; a++) { // <=>?
            asciiToCcKey[a] = { key: ",-./".charAt(a-60), shft:1 };
        }
        asciiToCcKey[64] = { key: '@' };
        for (a=65; a<91; a++) {  // A - Z
            asciiToCcKey[a] = { key: String.fromCharCode(a), shft:1 };
        }
        for (a=91; a<96; a++) {
            asciiToCcKey[a] = { key: String.fromCharCode(a) };
        }

        for (a=96; a<97; a++) {
            asciiToCcKey[a] = { key: String.fromCharCode(a-32), shft:1 };
        }
        for (a=97; a<123; a++) {  // a-z (really graphics codes)
            asciiToCcKey[a] = { key: String.fromCharCode(a-32) };
        }
        for (a=123; a<127; a++) {
            asciiToCcKey[a] = { key: String.fromCharCode(a-32), shft:1 };
        }

        for (a=128; a<159; a++) {
            asciiToCcKey[a] = { key: String.fromCharCode(a-64), ctrl:1, shft:1 };
        }
        for (a=160; a<192; a++) {
            asciiToCcKey[a] = { key:  asciiToCcKey[a-128].key,
                                shft: asciiToCcKey[a-128].shft,
                                ctrl: 1 };
        }
        for (a=192; a<256; a++) {
            asciiToCcKey[a] = { key:  'F' + (a % 16),
                                ctrl: (a % 32 < 16),
                                shft: (208 <= a && a <= 239) };
        }

        // ----- map key meaning to compucolor matrix encoding
        // this maps a key name (which might be an ascii value) to the
        // compucolor keyboard matrix encoding.  note that this table is
        // just the root key; control and shift modifiers are external to it.
        // most of these are documented in a table on pdf page 11 of
        // "Compucolor II and the TMS 5501.pdf".  However, the table has
        // two errors, and I discovered what the others map to by hacking
        // the emulator to activate those other positions and see what is
        // reported by this short program:
        //
        //    10 INPUT A$:PRINT ASC(A$):GOTO 10

        ccKey['0']    = { row: 15, bit: 0 };
        ccKey['1']    = { row: 14, bit: 0 };
        ccKey['2']    = { row: 13, bit: 0 };
        ccKey['3']    = { row: 12, bit: 0 };
        ccKey['4']    = { row: 11, bit: 0 };
        ccKey['5']    = { row: 10, bit: 0 };
        ccKey['6']    = { row:  9, bit: 0 };
        ccKey['7']    = { row:  8, bit: 0 };
        ccKey['8']    = { row:  7, bit: 0 };
        ccKey['9']    = { row:  6, bit: 0 };
        ccKey[':']    = { row:  5, bit: 0 };
        ccKey[';']    = { row:  4, bit: 0 };
        ccKey[',']    = { row:  3, bit: 0 };
        ccKey['-']    = { row:  2, bit: 0 };
        ccKey['.']    = { row:  1, bit: 0 };
        ccKey['/']    = { row:  0, bit: 0 };

        ccKey['@']    = { row: 15, bit: 1 };
        ccKey['A']    = { row: 14, bit: 1 };
        ccKey['B']    = { row: 13, bit: 1 };
        ccKey['C']    = { row: 12, bit: 1 };
        ccKey['D']    = { row: 11, bit: 1 };
        ccKey['E']    = { row: 10, bit: 1 };
        ccKey['F']    = { row:  9, bit: 1 };
        ccKey['G']    = { row:  8, bit: 1 };
        ccKey['H']    = { row:  7, bit: 1 };
        ccKey['I']    = { row:  6, bit: 1 };
        ccKey['J']    = { row:  5, bit: 1 };
        ccKey['K']    = { row:  4, bit: 1 };
        ccKey['L']    = { row:  3, bit: 1 };
        ccKey['M']    = { row:  2, bit: 1 };
        ccKey['N']    = { row:  1, bit: 1 };
        ccKey['O']    = { row:  0, bit: 1 };

        ccKey['P']    = { row: 15, bit: 2 };
        ccKey['Q']    = { row: 14, bit: 2 };
        ccKey['R']    = { row: 13, bit: 2 };
        ccKey['S']    = { row: 12, bit: 2 };
        ccKey['T']    = { row: 11, bit: 2 };
        ccKey['U']    = { row: 10, bit: 2 };
        ccKey['V']    = { row:  9, bit: 2 };
        ccKey['W']    = { row:  8, bit: 2 };
        ccKey['X']    = { row:  7, bit: 2 };
        ccKey['Y']    = { row:  6, bit: 2 };
        ccKey['Z']    = { row:  5, bit: 2 };
        ccKey['[']    = { row:  4, bit: 2 };
        ccKey['\\']   = { row:  3, bit: 2 };
        ccKey[']']    = { row:  2, bit: 2 };
        ccKey['^']    = { row:  1, bit: 2 };
        ccKey['_']    = { row:  0, bit: 2 };

        ccKey['F0']   = { row: 15, bit: 3 };
        ccKey['F1']   = { row: 14, bit: 3 };
        ccKey['F2']   = { row: 13, bit: 3 };
        ccKey['F3']   = { row: 12, bit: 3 };
        ccKey['F4']   = { row: 11, bit: 3 };
        ccKey['F5']   = { row: 10, bit: 3 };
        ccKey['F6']   = { row:  9, bit: 3 };
        ccKey['F7']   = { row:  8, bit: 3 };
        ccKey['F8']   = { row:  7, bit: 3 };
        ccKey['F9']   = { row:  6, bit: 3 };
        ccKey['F10']  = { row:  5, bit: 3 };
        ccKey['F11']  = { row:  4, bit: 3 };
        ccKey['F12']  = { row:  3, bit: 3 };
        ccKey['F13']  = { row:  2, bit: 3 };
        ccKey['F14']  = { row:  1, bit: 3 };
        ccKey['F15']  = { row:  0, bit: 3 };

        ccKey['break']   = { row: 15, bit: 4 };
        ccKey['inschar'] = { row: 14, bit: 4 };
        ccKey['delline'] = { row: 13, bit: 4 };
        ccKey['insline'] = { row: 12, bit: 4 };
        ccKey['delchar'] = { row: 11, bit: 4 };
        ccKey['auto']    = { row: 10, bit: 4 };
//      ccKey['xxxx']    = { row:  9, bit: 4 };  // the TMS 5501 note has this wrong
//      ccKey['xxxx']    = { row:  9, bit: 4 };  // chr 6: enters a state where the next keystroke defines fg/bg/blink
//      ccKey['xxxx']    = { row:  8, bit: 4 };  // the TMS 5501 note has this wrong
//      ccKey['xxxx']    = { row:  8, bit: 4 };  // chr 7
        ccKey['home']    = { row:  7, bit: 4 };  // chr 8, home
        ccKey['tab']     = { row:  6, bit: 4 };  // tab key
        ccKey['curdwn']  = { row:  5, bit: 4 };  // down arrow
        ccKey['eline']   = { row:  4, bit: 4 };  // erase line
        ccKey['epage']   = { row:  3, bit: 4 };  // erase page
        ccKey['cr']      = { row:  2, bit: 4 };  // CR key
        ccKey['a7on']    = { row:  1, bit: 4 };  // A7 on
        ccKey['bla7off'] = { row:  0, bit: 4 };  // A7/BL off

        // assorted others
        ccKey['black']   = { row: 15, bit: 5 };
        ccKey['red']     = { row: 14, bit: 5 };
        ccKey['green']   = { row: 13, bit: 5 };
        ccKey['yellow']  = { row: 12, bit: 5 };
        ccKey['blue']    = { row: 11, bit: 5 };
        ccKey['magenta'] = { row: 10, bit: 5 };
        ccKey['cyan']    = { row:  9, bit: 5 };  // the TMS 5501 note has this wrong
        ccKey['white']   = { row:  8, bit: 5 };  // the TMS 5501 note has this wrong
//      ccKey['xxxx']    = { row:  7, bit: 5 };  // chr 24 (CTRL-X)
        ccKey['currgt']  = { row:  6, bit: 5 };  // right arrow
        ccKey['curlft']  = { row:  5, bit: 5 };  // left arrow
        ccKey['esc']     = { row:  4, bit: 5 };  // esc
        ccKey['curup']   = { row:  3, bit: 5 };  // up arrow
        ccKey['fgon']    = { row:  2, bit: 5 };  // FG on
        ccKey['bgon']    = { row:  1, bit: 5 };  // BG on
        ccKey['blinkon'] = { row:  0, bit: 5 };  // blink on

        ccKey[' ']         = { row: 15, bit: 6 };  // space
//      ccKey['xxxx']      = { row: 14, bit: 6 },  // chr 33  "!"
//      ccKey['xxxx']      = { row: 13, bit: 6 },  // chr 34  (")
//      ccKey['xxxx']      = { row: 12, bit: 6 },  // chr 35  "#"
//      ccKey['xxxx']      = { row: 11, bit: 6 },  // chr 36  "$"
//      ccKey['xxxx']      = { row: 10, bit: 6 },  // chr 37  "%"
//      ccKey['xxxx']      = { row:  8, bit: 6 },  // chr 39  (')
//      ccKey['xxxx']      = { row:  7, bit: 6 },  // chr 40  "("
//      ccKey['xxxx']      = { row:  6, bit: 6 },  // chr 41  ")"
        ccKey['num*']      = { row:  5, bit: 6 };  // numeric keypad *
        ccKey['num+']      = { row:  4, bit: 6 };  // numeric keypad +
//      ccKey['xxxx']      = { row:  3, bit: 6 },  // chr 60  "<"
        ccKey['numequals'] = { row:  2, bit: 6 };  // numeric keypad =
//      ccKey['xxxx']      = { row:  1, bit: 6 },  // chr 62  ">"
//      ccKey['xxxx']      = { row:  0, bit: 6 },  // chr 63  "?"

//      ccKey['xxxx']      = { row: 15, bit: 7 },  // chr 249
//      ccKey['xxxx']      = { row: 14, bit: 7 },  // chr 249
//      ccKey['xxxx']      = { row: 13, bit: 7 },  // chr 251
//      ccKey['xxxx']      = { row: 12, bit: 7 },  // chr 251
//      ccKey['xxxx']      = { row: 11, bit: 7 },  // chr 253
//      ccKey['xxxx']      = { row: 10, bit: 7 },  // chr 253
//      ccKey['xxxx']      = { row:  8, bit: 7 },  // chr 255
//      ccKey['xxxx']      = { row:  7, bit: 7 },  // chr 249
//      ccKey['xxxx']      = { row:  6, bit: 7 },  // chr 249
//      ccKey['xxxx']      = { row:  5, bit: 7 },  // chr 251
//      ccKey['xxxx']      = { row:  4, bit: 7 },  // chr 251
//      ccKey['xxxx']      = { row:  3, bit: 7 },  // chr 253
//      ccKey['xxxx']      = { row:  2, bit: 7 },  // chr 253
//      ccKey['xxxx']      = { row:  1, bit: 7 },  // chr 255
//      ccKey['xxxx']      = { row:  0, bit: 7 },  // chr 255

        // modal keys
        ccKey['capslock'] = { row: 16, bit: 7 };
        ccKey['repeat']   = { row: 16, bit: 6 };
        ccKey['shft']     = { row: 16, bit: 5 };
        ccKey['ctrl']     = { row: 16, bit: 4 };

        // aliases
        ccKey['bksp']    = ccKey['curlft'];
        ccKey['delete']  = ccKey['delchar'];
        ccKey['insert']  = ccKey['inschar'];
        ccKey['num0']    = ccKey['0'];
        ccKey['num1']    = ccKey['1'];
        ccKey['num2']    = ccKey['2'];
        ccKey['num3']    = ccKey['3'];
        ccKey['num4']    = ccKey['4'];
        ccKey['num5']    = ccKey['5'];
        ccKey['num6']    = ccKey['6'];
        ccKey['num7']    = ccKey['7'];
        ccKey['num8']    = ccKey['8'];
        ccKey['num9']    = ccKey['9'];
        ccKey['num-']    = ccKey['-'];
        ccKey['num/']    = ccKey['/'];
        ccKey['num.']    = ccKey['.'];
    }

    function clearKey() {
        for (var i = 0; i < 17; i++) {
            kbMatrix[i] = 0xFF;  // nothing pressed
        }
    }

    function matrix(row) {
        return kbMatrix[row];
    }

    // map the pc keyboard event to a logical name.
    // often it is just the ascii code, but for keys which don't have an
    // ascii equivalent, like "home", it is a descriptive word.
    function mapPcKey(evt) {
        var keyName;
        if (evt.ctrlKey && (evt.keyCode >= 65) && (evt.keyCode <= 90)) {
            // ctrl A-Z
            keyName = String.fromCharCode(evt.keyCode);
        } else if (evt.shiftKey) {
            keyName = pcKey[ksh + evt.keyCode];
        }
        if (keyName === undefined) {
            // either shift wasn't pressed, or there was no shifted mapping,
            // so try the unshifted mapping
            keyName = pcKey[evt.keyCode];
        }
        return keyName;
    }

    // this is called only when no non-modal key is active.
    // this shouldn't be necessary at all, except for the case where
    // maybe there is a game which polls the state of one of these keys
    // to act as a FIRE button or something like that.
    function encodeModeKeys() {
        // don't complain that (e.g.) ccKey["A"] should be ccKey.A
        /* jshint sub: true */
        clearKey();
        kbMatrix[16] = (isDown['capslock'] ? 0x00 : 0x80) |
                       (isDown['repeat']   ? 0x00 : 0x40) |
                       (isDown['shft']     ? 0x00 : 0x20) |
                       (isDown['ctrl']     ? 0x00 : 0x10) |
                                                    0x0F;
    }

    function encodeASCII(keyName, useAmbientCtrl, useAmbientShft) {
        // don't complain that (e.g.) ccKey["A"] should be ccKey.A
        /* jshint sub: true */
        var asc, cc, ctrl, shft;
        if (keyName.length === 1) {
            // it is a raw ascii code
            asc = asciiToCcKey[keyName.charCodeAt(0)];
            if (asc === undefined) {
                alert('Error in encodeASCII');
            } else {
                // map that to the cc matrix encoding
                cc = ccKey[asc.key];
                ctrl = asc.ctrl;
                shft = asc.shft;
                // override if commanded to
                if (useAmbientCtrl) {
                    ctrl = isDown['ctrl'];
                }
                if (useAmbientShft) {
                    shft = isDown['shft'];
                }
            }
        } else {
            // it is a symbolic name, eg, "F7" or "curdwn".
            // do a direct lookup in the cc table.
            cc = ccKey[keyName];
            ctrl = isDown['ctrl'];
            shft = isDown['shft'];
        }

        clearKey();
        if (cc === undefined) {
            alert('Error in encodeASCII');
            return;
        }

        kbMatrix[cc.row] = (~(1 << cc.bit) & 0xFF);
        // we never drive capslock in this case -- we are counting
        // on whoever called us to fold together the state of the
        // capslock and shift to form an effective shift state.
        kbMatrix[16] = ( /* capslock */           0x80) |
                       (isDown['repeat'] ? 0x00 : 0x40) |
                       (shft             ? 0x00 : 0x20) |
                       (ctrl             ? 0x00 : 0x10) |
                                                  0x0F;
    }

    // map the actual keystate to what the ccII keyboard scanner sees.
    //
    // out [5:4] == 00 selects keyboard decoding.
    // out [3:0] drives the row decoder.
    // out [7] selects the special key sensing.
    //
    // Inputs are pulled up by default, and key presses pull the indicated
    // bit low.
    //
    // (the keyboard schematic seems to indicate a COMMAND key which acts
    //  like the shift and control keys are held down simultaneously)

    function pollModalKeys(evt) {
        /* jshint sub: true */
        isDown['alt']  = evt.altKey;
        isDown['ctrl'] = evt.ctrlKey;
        isDown['shft'] = evt.shiftKey;
        if (evt.getModifierState) {
            // we can't reliably know the capslock state just from keydown /
            // keyup pairs, since its behavior is that of a toggle.  instead,
            // on every event, capture the current capslock state.
            isDown['capslock'] = evt.getModifierState('CapsLock');
        } else {
            // if the browser doesn't support it, there's no recourse
            isDown['capslock'] = false;
        }
        if (repeatMode === 'alt') {
            // map the ALT key to stand in for the repeat key
            isDown['repeat'] = isDown['alt'];
        } else if (repeatMode === 'auto') {
            // detected PC auto repeat; use that
            isDown['repeat'] = isDown['autorepeat'];
        }
    }

    // given an ascii value, or a key name, map it onto the key matrix.
    // send undefined to clear the key matrix.
    function forceKey(ascii) {
        clearKey();
        if (ascii !== undefined) {
            var cck = ccKey[ascii];
            if (cck === undefined) {
                alert("Key '" + ascii +
                      "' (" + ascii.charCodeAt(0) + ') not mappable');
                return;
            }
            encodeASCII(ascii, true, true);
        }
    }

    // given an ascii value, map it to the keyboard matrix.
    // unlike forceKey, this one doesn't allow any control/shift
    // overrides, since it is called from an autotyper script.
    function asciiKey(ascii) {
        if (ascii === undefined) {
            clearKey();
        } else {
            encodeASCII(ascii, false, false);
        }
    }

    function onKeydown(e) {
        /* jshint sub: true */

        if (ccemu.debugging()) {
            return;
        }
        var evt = e || window.event;

        // if the pc sends two keydown events in a row with the same code
        // with no intervening keyup, remember it
        if (evt.keyCode === prevKeydown) {
            isDown['autorepeat'] = true;
        } else {
            isDown['autorepeat'] = false;
            if (!modalKeys[pcKey[evt.keyCode]]) {
                prevKeydown = evt.keyCode;
            } else {
                prevKeydown = undefined;
            }
        }
        pollModalKeys(evt);

        // defer some keys to the follow-on onKeypress event.
        // we can't handle it all here for two reasons:
        //    - firefox and ie9 report the state of the caps lock key,
        //      but webkit-based browsers don't.  as a result, we can't
        //      know if A-Z are shifted or not.
        //    - keydown tells you that, say, shift-2, is pressed, but
        //      not what it means.  on standard US PC keyboards, it is "@";
        //      on some other keyboards, it is double quote.
        //          http://en.wikipedia.org/wiki/Keyboard_layout
        // we don't use keypress handling for CTRL-whatever because
        // we don't care about the state of the capslock in such cases,
        // we just want to use the raw shift and control state because
        // that is what the compucolor does.
        if (useKeypress[evt.keyCode] && !evt.ctrlKey) {
            return;
        }
        var keyName = mapPcKey(evt);

        // the following isn't quite right -- the real machine was in a reset
        // state for the duration of the key depression, and came out
        // on its release, not when it was first depressed.
        //
        // in theory we don't need to distinguish it here.  we could just
        // do a warm reset and then let the ROM poll the ctrl & shift keys
        // to determine which kind of reset to do.  the problem is that
        // the warm reset rests the keyboard object, which clears out the
        // keyboard matrix, and the control and reset key state won't be
        // noticed until the next keydown/keyup event.
        if (keyName === 'reset') {
            if (evt.ctrlKey && evt.shiftKey) {
                ccemu.hardReset();
            } else {
                ccemu.warmReset();
            }
            return false;
        }

        // if autotyper is running, ignore all real keyboard input,
        // except for <ESC>, which cancels autotyper.
        if (autotyper.isRunning()) {
            if (keyName === 'esc') {
                autotyper.cancel();
            }
            // ignore real keyboard input
            evt.preventDefault();
            return false;
        }

        if (keyName) {
            isDown[keyName] = true;

            if (modalKeys[keyName]) {
                encodeModeKeys();
            } else { // non-modal key
                if ((keyName >= 'A' && keyName <= 'Z') ||
                    (keyName >= 'a' && keyName <= 'z')) {
                    // for single character keyName values, encodeASCII
                    // usually uses only what the ccKey translation table
                    // indicates for mode keys, but for alphabetic chars,
                    // we want the ambient ctrl & shift state to apply.
                    // in fact, we know that cntl is true if we are here,
                    // because non-ctrl cases are handled in keypress.
                    encodeASCII(keyName, true, true);
                } else {
                    // use ambient ctrl, but use shft from ccKey mapping
                    encodeASCII(keyName, true, false);
                }
            }
        }

        evt.preventDefault();
        return false;
    }

    function onKeypress(e) {
        if (ccemu.debugging() || autotyper.isRunning()) {
            return;
        }
        /* jshint sub: true */
        var evt = e || window.event;
        var charCode = evt.charCode;
        var ch       = String.fromCharCode(charCode);

        if (evt.ctrlKey) {
            return false; // how did we get here?  onKeydown supposedly killed ctrl key combinations
        }
        var handleSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
                        'abcdefghijklmnopqrstuvwxyz' +
                        '0123456789' +
                        ' !@#$%^&*()-_=+[]\\;:\'",<.>/?';
        if (handleSet.indexOf(ch) >= 0) {
            // it is safe to handle
            isDown[ch] = true;
            encodeASCII(ch, true, false);
            evt.preventDefault();
            return false;
        } else if (0) {
            alert('onKeypress saw character code ' + charCode +
                  '(' + ch + ')');
        }
    }

    function onKeyup(e) {
        if (ccemu.debugging()) {
            return;
        }
        /* jshint sub: true */
        var evt = e || window.event;
        isDown = [];
        prevKeydown = undefined;  // reset autorepeat
        pollModalKeys(evt);
        encodeModeKeys();
        return false;
    }

    function addEvent(evnt, elem, func) {
        if (elem.addEventListener) {   // W3C DOM
            elem.addEventListener(evnt, func, false);
        } else if (elem.attachEvent) { // IE DOM
            elem.attachEvent('on' + evnt, func);
        } else {
            elem[evnt] = func;
        }
    }

    // other initialization
    function reset() {
        clearKey();
    }

    // initialize state
    buildTables();
    reset();

    // bind keyevent handlers
    if (0) {
        // this approach breaks editing the "#nval" text box
        // it also knocks out the Caps Lock key detection in FF
        // using 'html' instead of document does the same thing
        $(document).keydown(onKeydown);
        $(document).keypress(onKeypress);
        $(document).keyup(onKeyup);
    } else {
        // because we need these, we can't kill off addEvent()
        addEvent('keydown',  document, onKeydown);
        addEvent('keypress', document, onKeypress);
        addEvent('keyup',    document, onKeyup);
    }

    // if the window loses focus, kill autorepeat
    // firefox is happy with either window or document; IE9 requires window
    addEvent('blur', window, function () {
        clearKey();
        prevKeydown = undefined;
    });

    // expose public members:
    return {
        'reset':     reset,
        'matrix':    matrix,
        'clearKey':  clearKey,
        'forceKey':  forceKey,
        'asciiKey':  asciiKey
    };

}());  // keybrd

keybrd = keybrd;  // keep jshint happy

// vim:et:sw=4:
