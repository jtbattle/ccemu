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
// keyboard mapping
//============================================================================

// Problem #1:
//
//    Browsers are inconsistent in their encoding of key events, both keydown
//    and keypress.  See http://unixpapa.com/js/key.html or google a bit to
//    find more.
//
//    What we care to know is when a given key is depressed and when it is
//    released, so that can be mapped onto the ccII keyboard matrix.  The
//    javascript "keydown" event is mostly what we want, but it isn't complete.
//    It provides an encoding of which key has gone done, and it also provides
//    any associated modal state: shift, control, alt.  However, it doesn't
//    provide the state of the CapsLock key, nor does it tell us which logical
//    key the user has pressed: for instance, SHIFT+"2" might be "@" or it
//    might be the double quote character ("), depending on the use keyboard.
//    So for such keys we have to wait for the keypress event, which does give
//    the encoded value.
//
//    So why not use keypress all the time?  It won't work because not all
//    browsers fire the event for all keys.  For example, IE, FF, and Opera
//    report ESC with a keypress event, but safari and chrome don't.  Function
//    keys produce a keypress event in FF and opera, but not IE, chrome, and
//    safari.
//
//    The keys where all browsers generate a keypress event are:
//        letters (a-z), numbers (0-9), punctuation, space, enter
//    Everything else is handled by keydown.  Note that the keydown event
//    happens before the keypress event, and in some browsers (IE, webkit)
//    canceling the default keydown behavior cancels the subsequent keypress.
//
//    In the future, one hopes the event.key property is supported, in which
//    case everything could be handled uniformly in the onkeydown event handler,
//    with no need for the keypress event handler.  As of Jan 2014, IE supports
//    it while deviating from the proposed standard; Firefox 26 not only
//    deviates from the standard but currently only for non-printable keys;
//    Chrome doesn't support it at all; Safari is probably like Chrome.
//
// Problem #2:
//
//    The compucolor keyboard has a very different layout from a standard PC,
//    and has many compucolor-specific keys.  The PC has some keys that don't
//    have a natural mapping to the compucolor.  Also, "=" is a shifted key on
//    the compucolor but not on a standard US PC keyboard, so we sometimes have
//    to lie and override the modifier keys.
//
// Problem #3:
//
//    The compucolor has a number of keys that don't have a PC equivalent,
//    e.g., the "repeat" key, the "erase page" and "erase line" keys, "AUTO",
//    "BLINK ON", "BL/A7 OFF", "A7 ON", etc.
//
//    Not all keys are available with lower end compucolor machines, so part of
//    the solution is to ignore the ones we can, but there are still many that
//    aren't easily mapped.  We could artificially map some of them to unique
//    PC keyboard keys, like "PAUSE/BREAK", but that is hard for the user to
//    deal with.
//
//    The emulator also has a "virtual keyboard" with a clickable visual
//    representation of the full keyboard.  It is a monster, though.
//
// Problem #4:
//
//    The state of the keyboard Caps Lock key can't always be known.  Pressing
//    the key produces keydown and keyup events, but since its action is a
//    toggle, it can't be known directly if it active or not.  IE and Firefox
//    do report the state of the caps lock key when other key events are
//    reported; Chrome doesn't currently support getModifierState() with
//    'CapsLock', but there is no reliable way to tell which browser supports
//    it or not (short of browser sniffing).  This program tries to use
//    getModifierState(), and can figure it out when alphabetic keys are
//    pressed, but otherwise must assume it isn't set.
//
//    Related to this, keyup events can get lost.  For instance, on Firefox
//    (and maybe other browsers), pressing the shift key down produces a keydown
//    event with a keycode of 16.  Then pressing the "A" key produces a keydown
//    even with a keycode of 65 and a keypress event with a charcode of 65.  If
//    these keys remain held down, a stream of keydown/keypress events with the
//    same values as the ones above are created, one for each autorepeat action
//    of the key.  But if the shift key is released and the "A" key remains
//    down, no keyup (with keycode=16) is generated.  After a short delay, a
//    stream of keydown/keypress events for "a" begins until the A key is
//    released.  This can confuse the caps key detection heuristic used by
//    the emulator for browsers which don't report getModiferState('CapsLock').
//
// Problem #5:
//
//    Browsers intercept some keys for their own purposes, and each browser
//    does it differently.  For instance, Firefox lets the emulator capture the
//    Ctrl-N key, but Chrome instead catches it first and opens up a new
//    browser.  In full screen mode, <ESC> causes the browsers to exit full
//    screen mode; in Firefox Ctrl-[ can be used to work around it; in Chrome,
//    Ctrl-[ also causes full screen mode to exit.
//
// Rather than polling the keyboard state every time the emulated CPU accesses
// an I/O port, instead every time there is a PC key up/down event, we note it
// and then translate that to the 17 rows of CC-II keyboard state.

// option flags for jslint:
/* global alert */
/* global ccemu, autotyper */

var keybrd = (function () {

    'use strict';

    // choose how to emulate the cc-II "repeat" key.
    // this is not exposed in order to simplify the UI.
    //    never  -- no repeat
    //    always -- as if the ccII "repeat" key is always down -- too fast!
    //    auto   -- use the PC's native autorepeat
    //    alt    -- use the PC's ALT button as the emulated REPEAT button
    var repeatMode = ['never', 'always', 'auto', 'alt'][2];

    // The variable "capslock_detectable" is undefined by default.  If at some
    // point getModiferState("capsLock") returns true, then capslock_detectable
    // will be set true.  If, during processing an alphabetic character in the
    // keypress handler, the heuristic determines that capslock must be active
    // yet getModifierState("CapsLock") is false, capslock_detectable is set
    // false.  So, in summary, we might belatedly figure out if getModifierState
    // is supported.
    var capslock_detectable;

    //========================================================================
    // static mapping state
    //========================================================================

    // different key representations:
    //     keyCode:
    //         PC key encoding from javascript onkeydown/onkeyup
    //     charCode:
    //         PC key encoding from javascript onkeypress which is
    //         somewhat like keyCode but takes into account the state
    //         of the shift and capslock keys
    //     logical name:
    //         Key meaning -- the ascii name for ascii characters, eg
    //         '1', '!', 'a', and 'A', but also things like 'home'
    //     ccKeyName:
    //         The name of the ccIIkeyboard base key.  Often it coincides
    //         with the logical name, eg 'esc', 'home', 'A', '1', but
    //         diverges in that the shifted values aren't represented,
    //         eg, 'A' is used in place of 'a'.  This representation is
    //         used where we want to refer to a concrete ccII key, not
    //         the logical meaning of the key.
    //     ccII base key matrix encoding:
    //         they row and bit encoding on the hardware scanning keyboard
    //         matrix

    var keycodeToLogical = [];   // map event keycode to logical meaning
    var keycodeToLogical2 = [];  // same, but for learned keys
    var ccKeyToMatrix = {};      // map meaning to compucolor encoding
    var ccKeyShift = {};         // keys with shift state different from PC's
    var asciiToCcKey = [];       // map ascii values to cc key + modifiers

    // which logical key names correspond to mode keys
    var modalKeys = {
            'shft': true,
            'ctrl': true,
            'alt': true,
            'capslock': true
        };

    function buildTables() {
        /* jshint sub: true */
        // don't complain that (e.g.) foo["A"] should be foo.A

        // ----- map javascript event keycode to logical key name.
        //       this is just the subset which can't be determined
        //       from their ascii values.

        // modal keys
        keycodeToLogical[ 16] = 'shft';
        keycodeToLogical[ 17] = 'ctrl';
        keycodeToLogical[ 18] = 'alt';
        keycodeToLogical[ 20] = 'capslock';

        // various non-textual characters
        keycodeToLogical[  8] = 'bksp';   // backspace
        keycodeToLogical[  9] = 'tab';    // tab
        keycodeToLogical[ 13] = 'cr';     // carriage return
        keycodeToLogical[ 27] = 'esc';    // escape
        keycodeToLogical[ 36] = 'home';
        keycodeToLogical[ 37] = 'curlft';
        keycodeToLogical[ 38] = 'curup';
        keycodeToLogical[ 39] = 'currgt';
        keycodeToLogical[ 40] = 'curdwn';

        keycodeToLogical[  3] = 'break';  // pause/break + ctrl
        keycodeToLogical[ 19] = 'break';  // pause/break

        // keys on the PC keyboard that don't have a natural mapping
        // to the CC-II.
    //  keycodeToLogical[ 33] = "pgup";
    //  keycodeToLogical[ 34] = "pgdn";
        keycodeToLogical[ 35] = 'break';       // END key
    //  keycodeToLogical[ 44] = "prntscrn";
        keycodeToLogical[ 45] = "insert";
        keycodeToLogical[ 46] = "delete";
    //  keycodeToLogical[144] = "numlock";
    //  keycodeToLogical[145] = "scrolllock";

        keycodeToLogical[112] = 'F1';
        keycodeToLogical[113] = 'F2';
        keycodeToLogical[114] = 'F3';
        keycodeToLogical[115] = 'F4';
        keycodeToLogical[116] = 'F5';
        keycodeToLogical[117] = 'F6';
        keycodeToLogical[118] = 'F7';
        keycodeToLogical[119] = 'F8';
        keycodeToLogical[120] = 'F9';
        keycodeToLogical[121] = 'F10';
        keycodeToLogical[122] = 'F11';
        keycodeToLogical[123] = 'F12';

        // numeric keypad
        keycodeToLogical[ 96] = 'num0';
        keycodeToLogical[ 97] = 'num1';
        keycodeToLogical[ 98] = 'num2';
        keycodeToLogical[ 99] = 'num3';
        keycodeToLogical[100] = 'num4';
        keycodeToLogical[101] = 'num5';
        keycodeToLogical[102] = 'num6';
        keycodeToLogical[103] = 'num7';
        keycodeToLogical[104] = 'num8';
        keycodeToLogical[105] = 'num9';
        keycodeToLogical[107] = 'num+';
        keycodeToLogical[109] = 'num-';
        keycodeToLogical[106] = 'num*';
        keycodeToLogical[111] = 'num/';
        keycodeToLogical[110] = 'num.';

        // ----- map all 256 ascii values to a corrresponding compucolor key
        //       combination
        // This was taken from Colorcue Vol 4, No 4, p. 18
        // however, for A-Z, the table presupposes Caps Lock is active;
        // for those keys, the SHIFT state is inverted relative to the table.
        // Note that there is some ambiguity: "+" could possibly be represented
        // by either the main keyboard "+" key or the numeric keypad "+" key.
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
        for (a=123; a<128; a++) {
            asciiToCcKey[a] = { key: String.fromCharCode(a-32), shft:1 };
        }

        for (a=128; a<160; a++) {
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
        // this maps a ccII key name to the compucolor keyboard matrix
        // encoding.  note that this table is just the root key; control and
        // shift modifiers are external to it.  most of these are documented in
        // a table on pdf page 11 of "Compucolor II and the TMS 5501.pdf".
        // However, the table has two errors, and I discovered what the others
        // map to by hacking the emulator to activate those other positions and
        // see what is reported by this short program:
        //
        //    10 INPUT A$:PRINT ASC(A$):GOTO 10

        ccKeyToMatrix['0']    = { row: 15, bit: 0 };
        ccKeyToMatrix['1']    = { row: 14, bit: 0 };
        ccKeyToMatrix['2']    = { row: 13, bit: 0 };
        ccKeyToMatrix['3']    = { row: 12, bit: 0 };
        ccKeyToMatrix['4']    = { row: 11, bit: 0 };
        ccKeyToMatrix['5']    = { row: 10, bit: 0 };
        ccKeyToMatrix['6']    = { row:  9, bit: 0 };
        ccKeyToMatrix['7']    = { row:  8, bit: 0 };
        ccKeyToMatrix['8']    = { row:  7, bit: 0 };
        ccKeyToMatrix['9']    = { row:  6, bit: 0 };
        ccKeyToMatrix[':']    = { row:  5, bit: 0 };
        ccKeyToMatrix[';']    = { row:  4, bit: 0 };
        ccKeyToMatrix[',']    = { row:  3, bit: 0 };
        ccKeyToMatrix['-']    = { row:  2, bit: 0 };
        ccKeyToMatrix['.']    = { row:  1, bit: 0 };
        ccKeyToMatrix['/']    = { row:  0, bit: 0 };

        ccKeyToMatrix['@']    = { row: 15, bit: 1 };
        ccKeyToMatrix['A']    = { row: 14, bit: 1 };
        ccKeyToMatrix['B']    = { row: 13, bit: 1 };
        ccKeyToMatrix['C']    = { row: 12, bit: 1 };
        ccKeyToMatrix['D']    = { row: 11, bit: 1 };
        ccKeyToMatrix['E']    = { row: 10, bit: 1 };
        ccKeyToMatrix['F']    = { row:  9, bit: 1 };
        ccKeyToMatrix['G']    = { row:  8, bit: 1 };
        ccKeyToMatrix['H']    = { row:  7, bit: 1 };
        ccKeyToMatrix['I']    = { row:  6, bit: 1 };
        ccKeyToMatrix['J']    = { row:  5, bit: 1 };
        ccKeyToMatrix['K']    = { row:  4, bit: 1 };
        ccKeyToMatrix['L']    = { row:  3, bit: 1 };
        ccKeyToMatrix['M']    = { row:  2, bit: 1 };
        ccKeyToMatrix['N']    = { row:  1, bit: 1 };
        ccKeyToMatrix['O']    = { row:  0, bit: 1 };

        ccKeyToMatrix['P']    = { row: 15, bit: 2 };
        ccKeyToMatrix['Q']    = { row: 14, bit: 2 };
        ccKeyToMatrix['R']    = { row: 13, bit: 2 };
        ccKeyToMatrix['S']    = { row: 12, bit: 2 };
        ccKeyToMatrix['T']    = { row: 11, bit: 2 };
        ccKeyToMatrix['U']    = { row: 10, bit: 2 };
        ccKeyToMatrix['V']    = { row:  9, bit: 2 };
        ccKeyToMatrix['W']    = { row:  8, bit: 2 };
        ccKeyToMatrix['X']    = { row:  7, bit: 2 };
        ccKeyToMatrix['Y']    = { row:  6, bit: 2 };
        ccKeyToMatrix['Z']    = { row:  5, bit: 2 };
        ccKeyToMatrix['[']    = { row:  4, bit: 2 };
        ccKeyToMatrix['\\']   = { row:  3, bit: 2 };
        ccKeyToMatrix[']']    = { row:  2, bit: 2 };
        ccKeyToMatrix['^']    = { row:  1, bit: 2 };
        ccKeyToMatrix['_']    = { row:  0, bit: 2 };

        ccKeyToMatrix['F0']   = { row: 15, bit: 3 };
        ccKeyToMatrix['F1']   = { row: 14, bit: 3 };
        ccKeyToMatrix['F2']   = { row: 13, bit: 3 };
        ccKeyToMatrix['F3']   = { row: 12, bit: 3 };
        ccKeyToMatrix['F4']   = { row: 11, bit: 3 };
        ccKeyToMatrix['F5']   = { row: 10, bit: 3 };
        ccKeyToMatrix['F6']   = { row:  9, bit: 3 };
        ccKeyToMatrix['F7']   = { row:  8, bit: 3 };
        ccKeyToMatrix['F8']   = { row:  7, bit: 3 };
        ccKeyToMatrix['F9']   = { row:  6, bit: 3 };
        ccKeyToMatrix['F10']  = { row:  5, bit: 3 };
        ccKeyToMatrix['F11']  = { row:  4, bit: 3 };
        ccKeyToMatrix['F12']  = { row:  3, bit: 3 };
        ccKeyToMatrix['F13']  = { row:  2, bit: 3 };
        ccKeyToMatrix['F14']  = { row:  1, bit: 3 };
        ccKeyToMatrix['F15']  = { row:  0, bit: 3 };

        ccKeyToMatrix['break']   = { row: 15, bit: 4 };
        ccKeyToMatrix['inschar'] = { row: 14, bit: 4 };
        ccKeyToMatrix['delline'] = { row: 13, bit: 4 };
        ccKeyToMatrix['insline'] = { row: 12, bit: 4 };
        ccKeyToMatrix['delchar'] = { row: 11, bit: 4 };
        ccKeyToMatrix['auto']    = { row: 10, bit: 4 };
//      ccKeyToMatrix['xxxx']    = { row:  9, bit: 4 };  // the TMS 5501 note has this wrong
//      ccKeyToMatrix['xxxx']    = { row:  9, bit: 4 };  // chr 6: enters a state where the next keystroke defines fg/bg/blink
//      ccKeyToMatrix['xxxx']    = { row:  8, bit: 4 };  // the TMS 5501 note has this wrong
//      ccKeyToMatrix['xxxx']    = { row:  8, bit: 4 };  // chr 7
        ccKeyToMatrix['home']    = { row:  7, bit: 4 };  // chr 8, home
        ccKeyToMatrix['tab']     = { row:  6, bit: 4 };  // tab key
        ccKeyToMatrix['curdwn']  = { row:  5, bit: 4 };  // down arrow
        ccKeyToMatrix['eline']   = { row:  4, bit: 4 };  // erase line
        ccKeyToMatrix['epage']   = { row:  3, bit: 4 };  // erase page
        ccKeyToMatrix['cr']      = { row:  2, bit: 4 };  // CR key
        ccKeyToMatrix['a7on']    = { row:  1, bit: 4 };  // A7 on
        ccKeyToMatrix['bla7off'] = { row:  0, bit: 4 };  // A7/BL off

        // assorted others
        ccKeyToMatrix['black']   = { row: 15, bit: 5 };
        ccKeyToMatrix['red']     = { row: 14, bit: 5 };
        ccKeyToMatrix['green']   = { row: 13, bit: 5 };
        ccKeyToMatrix['yellow']  = { row: 12, bit: 5 };
        ccKeyToMatrix['blue']    = { row: 11, bit: 5 };
        ccKeyToMatrix['magenta'] = { row: 10, bit: 5 };
        ccKeyToMatrix['cyan']    = { row:  9, bit: 5 };  // the TMS 5501 note has this wrong
        ccKeyToMatrix['white']   = { row:  8, bit: 5 };  // the TMS 5501 note has this wrong
//      ccKeyToMatrix['xxxx']    = { row:  7, bit: 5 };  // chr 24 (CTRL-X)
        ccKeyToMatrix['currgt']  = { row:  6, bit: 5 };  // right arrow
        ccKeyToMatrix['curlft']  = { row:  5, bit: 5 };  // left arrow
        ccKeyToMatrix['esc']     = { row:  4, bit: 5 };  // esc
        ccKeyToMatrix['curup']   = { row:  3, bit: 5 };  // up arrow
        ccKeyToMatrix['fgon']    = { row:  2, bit: 5 };  // FG on
        ccKeyToMatrix['bgon']    = { row:  1, bit: 5 };  // BG on
        ccKeyToMatrix['blinkon'] = { row:  0, bit: 5 };  // blink on

        ccKeyToMatrix[' ']       = { row: 15, bit: 6 };  // space
//      ccKeyToMatrix['xxxx']    = { row: 14, bit: 6 },  // chr 33  "!"
//      ccKeyToMatrix['xxxx']    = { row: 13, bit: 6 },  // chr 34  (")
//      ccKeyToMatrix['xxxx']    = { row: 12, bit: 6 },  // chr 35  "#"
//      ccKeyToMatrix['xxxx']    = { row: 11, bit: 6 },  // chr 36  "$"
//      ccKeyToMatrix['xxxx']    = { row: 10, bit: 6 },  // chr 37  "%"
//      ccKeyToMatrix['xxxx']    = { row:  8, bit: 6 },  // chr 39  (')
//      ccKeyToMatrix['xxxx']    = { row:  7, bit: 6 },  // chr 40  "("
//      ccKeyToMatrix['xxxx']    = { row:  6, bit: 6 },  // chr 41  ")"
        ccKeyToMatrix['num*']    = { row:  5, bit: 6 };  // numeric keypad *
        ccKeyToMatrix['num+']    = { row:  4, bit: 6 };  // numeric keypad +
//      ccKeyToMatrix['xxxx']    = { row:  3, bit: 6 },  // chr 60  "<"
        ccKeyToMatrix['num=']    = { row:  2, bit: 6 };  // numeric keypad =
//      ccKeyToMatrix['xxxx']    = { row:  1, bit: 6 },  // chr 62  ">"
//      ccKeyToMatrix['xxxx']    = { row:  0, bit: 6 },  // chr 63  "?"

//      ccKeyToMatrix['xxxx']    = { row: 15, bit: 7 },  // chr 249
//      ccKeyToMatrix['xxxx']    = { row: 14, bit: 7 },  // chr 249
//      ccKeyToMatrix['xxxx']    = { row: 13, bit: 7 },  // chr 251
//      ccKeyToMatrix['xxxx']    = { row: 12, bit: 7 },  // chr 251
//      ccKeyToMatrix['xxxx']    = { row: 11, bit: 7 },  // chr 253
//      ccKeyToMatrix['xxxx']    = { row: 10, bit: 7 },  // chr 253
//      ccKeyToMatrix['xxxx']    = { row:  8, bit: 7 },  // chr 255
//      ccKeyToMatrix['xxxx']    = { row:  7, bit: 7 },  // chr 249
//      ccKeyToMatrix['xxxx']    = { row:  6, bit: 7 },  // chr 249
//      ccKeyToMatrix['xxxx']    = { row:  5, bit: 7 },  // chr 251
//      ccKeyToMatrix['xxxx']    = { row:  4, bit: 7 },  // chr 251
//      ccKeyToMatrix['xxxx']    = { row:  3, bit: 7 },  // chr 253
//      ccKeyToMatrix['xxxx']    = { row:  2, bit: 7 },  // chr 253
//      ccKeyToMatrix['xxxx']    = { row:  1, bit: 7 },  // chr 255
//      ccKeyToMatrix['xxxx']    = { row:  0, bit: 7 },  // chr 255

        // modal keys
        ccKeyToMatrix['capslock'] = { row: 16, bit: 7 };
        ccKeyToMatrix['repeat']   = { row: 16, bit: 6 };
        ccKeyToMatrix['shft']     = { row: 16, bit: 5 };
        ccKeyToMatrix['ctrl']     = { row: 16, bit: 4 };

        // aliases
        ccKeyToMatrix['bksp']    = ccKeyToMatrix['curlft'];
        ccKeyToMatrix['delete']  = ccKeyToMatrix['delchar'];
        ccKeyToMatrix['insert']  = ccKeyToMatrix['inschar'];
        ccKeyToMatrix['num0']    = ccKeyToMatrix['0'];
        ccKeyToMatrix['num1']    = ccKeyToMatrix['1'];
        ccKeyToMatrix['num2']    = ccKeyToMatrix['2'];
        ccKeyToMatrix['num3']    = ccKeyToMatrix['3'];
        ccKeyToMatrix['num4']    = ccKeyToMatrix['4'];
        ccKeyToMatrix['num5']    = ccKeyToMatrix['5'];
        ccKeyToMatrix['num6']    = ccKeyToMatrix['6'];
        ccKeyToMatrix['num7']    = ccKeyToMatrix['7'];
        ccKeyToMatrix['num8']    = ccKeyToMatrix['8'];
        ccKeyToMatrix['num9']    = ccKeyToMatrix['9'];
        ccKeyToMatrix['num-']    = ccKeyToMatrix['-'];
        ccKeyToMatrix['num/']    = ccKeyToMatrix['/'];
        ccKeyToMatrix['num.']    = ccKeyToMatrix['.'];

        // mark keys where the shift state is different than on a PC keyboard.
        // the value is what SHIFT should be on the ccII keyboard matrix.
        // for all other keys, either shift doesn't matter, or it matches the
        // shift state used by a PC keyboard.
        ccKeyShift[':'] = false;
        ccKeyShift['='] = true;
        ccKeyShift['_'] = false;
        ccKeyShift['^'] = false;
        ccKeyShift['@'] = false;
        ccKeyShift["'"] = true;
        // curious cases:
        //    - on the PC kb, "+" is shifted (shift-=), but there is also an
        //      unshifted "+" on the numeric keypad.  The ccII also has a
        //      shifted "+" (shift-;) and an unshifted numeric keypad "+".
        //      deal with it later.
        //    - on the PC kb, "*" is shifted (shift-8), but there is also an
        //      unshifted "*" on the numeric keypad.  The ccII also has a
        //      shifted "*" (shift-:) and an unshifted numeric keypad "*".
        //      deal with it later.
        //    - the PC has just the unshifted equal, while the equivalent
        //      ccII keyboard key is shifted.  But the ccII also has a
        //      numeric keypad equals, which is unshifted.
    }

    // map a logical key name to the root ccII key it corresponds to.
    // for instance, both 'A' and 'a' map to 'A', and both '1' and '!'
    // map to '1'.
    function logicalToCcIIkeyname(keyname) {
        var from = 'abcdefghijklmnopqrstuvwxyz!"#$%&\'()0=+*<>?';
        var to   = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890-;:,./';
        var p = from.indexOf(keyname);
        if (p >= 0) {
            return to.charAt(p);
        }

        // assume 1:1 mapping
        return keyname;
    }

    //========================================================================
    // emulate the ccII keyboard state
    //========================================================================

    // Every time a PC key is depressed, it gets logged here.
    // It is reported as a ccKey name, eg, 'esc', 'shft', 'A', 'num0'.
    // There can be multiple keys being held down, in which case they are
    // encoded as the most recent of all the keyswitch activations, which may
    // not exactly match what the real ccII does.
    var activeCcKeys = [];    // which key is currently depressed

    // encoded CC-II keyboard matrix state
    // [16] corresponds to the special decode for shift/control/repeat/capslock
    var kbMatrix = [];

    // wipe out the ccII keyboard state
    function ccIIclear() {
        /* jshint sub: true */
        for (var i = 0; i < 17; i++) {
            kbMatrix[i] = 0xFF;  // nothing pressed
        }
        isDown['autorepeat'] = false;
    }

    function ccIIKbReset() {
        ccIIclear();
        activeCcKeys = [];
        ccIIencodeMatrix();
        prevKeydown = undefined;
    }

    // remove a key from the list of active ccII keys
    function ccIIremoveKey(ccKeyname) {
        var len = activeCcKeys.length;
        for (var n=0; n < len; n++) {
            if (activeCcKeys[n].keyname === ccKeyname) {
                activeCcKeys.splice(n, 1);
                return;
            }
        }
    }

    // add key to end of list of active keys.
    // this needs to take logical keyname because the ccKeyShift[]
    // index has to be the actual key value, not the root ccKey.
    function ccIIkeydown(logicalKey, synthetic) {
        /* jshint sub: true */
        var ccKeyname = logicalToCcIIkeyname(logicalKey);
        // remove it if it already exists
        ccIIremoveKey(ccKeyname);
        // add it to the end of the list
        var cck = ccKeyToMatrix[ccKeyname];
        if (cck === undefined) {
            alert("Error: unknown keyname " + ccKeyname);
            return;
        }
        var sh = (synthetic) ? isDown['shft'] : ccKeyShift[logicalKey];
        var info = { keyname: ccKeyname,
                     row: cck.row,
                     bit: cck.bit,
                     shft: sh };
        activeCcKeys.push(info);
    }

    // encode the list of currently depressed keys to something reasonable.
    // it is not possible to be perfect, though.  it does support depressing
    // multiple keys at the same time.
    function ccIIencodeMatrix() {
        /* jshint sub: true */
        var len = activeCcKeys.length;
        // clear the keyboard matrix (nothing depressed)
        for (var i = 0; i < 17; i++) {
            kbMatrix[i] = 0xFF;
        }

        // the modal keys are a special case. they are encoded
        // up front, and subsequent keys can override it.
        kbMatrix[16] = (isDown['capslock'] ? 0x00 : 0x80) |
                       (isDown['repeat']   ? 0x00 : 0x40) |
                       (isDown['shft']     ? 0x00 : 0x20) |
                       (isDown['ctrl']     ? 0x00 : 0x10) |
                                                    0x0F;

        // scan keys from oldest to newest. The shift state can be overridden
        // only if it is the most recent key.
        var first_key = true;
        for (var n=len-1; n >= 0; n--) {
            var info = activeCcKeys[n];
            if (!modalKeys[info.keyname]) {
                // set the corresponding state:
                kbMatrix[info.row] &= (~(1 << info.bit) & 0xFF);
                // if it has a sh- or unsh- prefix, override the state of the
                // shift key
                if (first_key && info.shft === true) {
                    kbMatrix[16] &= ~0x20;  // set the shift
                } else if (first_key && info.shft === false) {
                    kbMatrix[16] |= 0x20;  // clear the shift
                }
                first_key = false;
            }
        }
    }

    // return the state of the specified row
    function ccIIMatrix(row) {
        return kbMatrix[row];
    }

    //========================================================================
    // catch pc keyboard events and communicate it to ccII model
    //========================================================================

    var isDown = [];    // true if this ccII key is currently depressed
    var prevKeydown;    // most recently seen keydown keyCode

    // which keys we care to process in onkeypress event handler
    var keypressKeys = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
                       'abcdefghijklmnopqrstuvwxyz' +
                       '0123456789' +
                       ' !@#$%^&*()-_=+[]\\;:\'",<.>/?';

    function pollModalKeys(evt) {
        /* jshint sub: true */
        isDown['alt']  = evt.altKey;
        isDown['ctrl'] = evt.ctrlKey;
        isDown['shft'] = evt.shiftKey;

        // we can't reliably know the capslock state just from keydown /
        // keyup pairs, since its behavior is that of a toggle.  try to
        // determine it though other means.
        if (capslock_detectable === undefined) {
            if (!evt.getModifierState) {
                capslock_detectable = false;
            } else if (evt.getModifierState('CapsLock')) {
                capslock_detectable = true;
            }
        }
        // if getModifierState() works, immediately set isDown['capslock'].
        // otherwise, leave the state alone and set it when the next alphabetic
        // character is hit.
        if (capslock_detectable) {
            isDown['capslock'] = evt.getModifierState('CapsLock');
        }

        // set the repeat key based on the chosen emulation method
        switch (repeatMode) {
            case 'auto':
                // detected PC auto repeat; use that
                isDown['repeat'] = isDown['autorepeat'];
                break;
            case 'alt':
                // map the ALT key to stand in for the repeat key
                isDown['repeat'] = isDown['alt'];
                break;
            case 'always':
                isDown['repeat'] = true;
                break;
            case 'never':
                isDown['repeat'] = false;
                break;
        }
    }

    // this fires when a key is first physically depressed,
    // and on each autorepeat
    function onKeydown(e) {
        /* jshint sub: true */
        if (ccemu.debugging()) {
            return;
        }
        var evt = e || window.event;

        pollModalKeys(evt);

        // if the pc sends two keydown events in a row with the same code
        // with no intervening keyup, remember it
        if (evt.keyCode === prevKeydown) {
            isDown['autorepeat'] = true;
        } else {
            isDown['autorepeat'] = false;
            if (modalKeys[keycodeToLogical[evt.keyCode]]) {
                prevKeydown = undefined;
            } else {
                prevKeydown = evt.keyCode;
            }
        }

        // map the event keyCode to the logical and ccII key name.
        // if no mapping exists, either it is a key we don't care about,
        // (e.g., the "windows" key), or we can't know the meaning of the
        // key until the onkeypress event (e.g., 190 -> '.' in firefox).
        var keyName = keycodeToLogical[evt.keyCode];
        if (keyName === undefined) {
            return;
        }

        // the following isn't quite right -- the real machine was in a reset
        // state for the duration of the key depression, and came out
        // on its release, not when it was first depressed.
        //
        // in theory we don't need to distinguish it here.  we could just
        // do a warm reset and then let the ROM poll the ctrl & shift keys
        // to determine which kind of reset to do.  the problem is that
        // the warm reset resets the keyboard object, which clears out the
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

        if ((keyName !== undefined) && !modalKeys[keyName]) {
            ccIIkeydown(keyName);
        }
        ccIIencodeMatrix();

        // suppress further processing
        evt.preventDefault();
        return false;
    }

    // this fires when a key is physically pressed;
    // it fires every time the key autorepeats
    function onKeypress(e) {
        /* jshint sub: true */
        var evt = e || window.event;
        var charCode = evt.charCode || evt.keyCode; // IE doesn't have charCode
        var ch = String.fromCharCode(charCode);

        if (ccemu.debugging() || autotyper.isRunning()) {
            return;
        }

        // process only certain keys and ignore the rest
        if (keypressKeys.indexOf(ch) < 0) {
            // prevent further processing
            evt.preventDefault();
            return false;
        }

        // detect if CapsLock is depressed, and if getModifierState() works
        var detected_capslock = (ch >= 'A' && ch <= 'Z' && !evt.shiftKey) ||
                                (ch >= 'a' && ch <= 'z' &&  evt.shiftKey) ;
        if (detected_capslock && (capslock_detectable === undefined)) {
            capslock_detectable = false;  // getModifierState() must not work
        }
        if (capslock_detectable) {
            // why not just use detected_capslock? because getModifierState
            // can report that capslock is on or off even if the current key
            // isn't a letter.
            isDown['capslock'] = evt.getModifierState('CapsLock');
        } else if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
            isDown['capslock'] = detected_capslock;
        }

        if (prevKeydown !== undefined) {
            ccIIkeydown(ch);
            ccIIencodeMatrix();

            // for keys where onkeydown didn't have a mapping, fix that by
            // creating the mapping so onKeyup() knows which key to release.
            // we have to set it every time for cases like this:
            //    PC SHIFT-2 produces "@", which maps to ccKey "@" which is
            //    its own key.  If we just remembered the first mapping we
            //    saw, pressing "2" would teach onkeyup that keycode 50 means
            //    "2", and later one when we got a "@" from SHIFT-2, on release
            //    it wouldn't be able to find the key in the active key list.
            keycodeToLogical2[prevKeydown] = logicalToCcIIkeyname(ch);

            // prevent further processing
            evt.preventDefault();
            return false;
        }
    }

    // this fires when a key is physically released, but in some circumstances
    // it doesn't fire, so it isn't 100% reliable.
    function onKeyup(e) {
        /* jshint sub: true */
        var evt = e || window.event;
        if (ccemu.debugging()) {
            return;
        }
        var keyName = keycodeToLogical[evt.keyCode] ||   // static mapping
                      keycodeToLogical2[evt.keyCode];    // learned mapping
        var ccKeyname = logicalToCcIIkeyname(keyName);
        if (keyName !== undefined && !modalKeys[keyName]) {
            ccIIremoveKey(ccKeyname);
        }
        pollModalKeys(evt);
        isDown['autorepeat'] = false;
        if (repeatMode === 'auto') {
            isDown['repeat'] = false;
        }
        ccIIencodeMatrix();
        return false;
    }

    // given an ascii value, or a key name, map it onto the key matrix.
    // send undefined to clear the key matrix.  it is called from the auto
    // button, the virtual keyboard, and on startup if the URL specified an
    // autostart.
    function virtualKey(keyobj) {
        /* jshint sub: true */
        ccIIKbReset();
        isDown = [];
        isDown['ctrl'] = keyobj.ctrl;
        isDown['shft'] = keyobj.shft;
        isDown['repeat'] = keyobj.repeat;
        isDown['capslock'] = keyobj.capslock;
        if (keyobj.key !== undefined) {
            ccIIkeydown(keyobj.key, true);
        }
        ccIIencodeMatrix();
    }

    // Given an ascii value, map it to the keyboard matrix.
    // It is called only from autotyper, and only if the key-at-a-time
    // keyboard stuffing is in effect (normally it is line-at-time).
    function asciiKey(ascii) {
        /* jshint sub: true */
        ccIIKbReset();
        isDown = [];
        if (ascii !== undefined) {
            var asc = asciiToCcKey[ascii.charCodeAt(0)];
            if (asc === undefined) {
                alert("Error in asciiKey: code =" + ascii.charCodeAt(0));
                return;
            }
            isDown['ctrl'] = asc.ctrl;
            isDown['shft'] = asc.shft;
            isDown['repeat'] = false;
            isDown['capslock'] = false;
            ccIIkeydown(asc.key, true);
            ccIIencodeMatrix();
        }
    }

    //========================================================================
    // plumbing
    //========================================================================

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
        ccIIKbReset();
    }

    // initialize state
    buildTables();
    reset();

    addEvent('keydown',  document, onKeydown);
    addEvent('keypress', document, onKeypress);
    addEvent('keyup',    document, onKeyup);

    // firefox is happy with either window or document; IE9 requires window
    addEvent('blur', window, function () { reset(); });

    // expose public members:
    return {
        'reset':      reset,
        'matrix':     ccIIMatrix,
        'virtualKey': virtualKey,
        'asciiKey':   asciiKey
    };

}());  // keybrd

keybrd = keybrd;  // keep jshint happy

// vim:et:sw=4:
