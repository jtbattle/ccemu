// Copyright (c) 2014, Jim Battle
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

// option flags for jslint:
/* global crt */

// GLOBALS
var joystick;

//============================================================================
// joystick emulation
//============================================================================

// simple mapping using mouse:
//    map the x DAC as the x position varies from the left edge of the
//        canvas (0) to the right (255)
//    map the y DAC as the y position varies from the top edge of the
//        canvas (255) to the bottom (0)
//    map the left mouse button to the joystick button state

var joystick = (function () {

    // captured state on mousemove
    var cur_x = 0,
        cur_y = 0,
        cur_button = false;

    // called once to set things up
    function init() {
        var bdy = $('body');
        bdy.mousemove(handleMouseMove);
        bdy.mouseup(handleMouseUp);
        bdy.mousedown(handleMouseDown);
//      $('#canv').css({'cursor': 'none'});
    }

    function handleMouseUp(event) {
        var evt = event || window.event;  // IE
        if (evt.which === 1) {
            cur_button = false;
        }
    }

    function handleMouseDown(event) {
        var evt = event || window.event;  // IE
        if (evt.which === 1) {
            cur_button = true;
        }
    }

    function handleMouseMove(event) {
        var evt = event || window.event;  // IE
        cur_x = evt.clientX;
        cur_y = evt.clientY;
    }

    function getJoyState() {
        var canv = $('#canv');
        var offset = canv.offset();
        var offset_w = canv.width();
        var offset_h = canv.height();
        var margin = crt.getCanvasMargin();

        var x = Math.floor(255 * (cur_x - offset.left - margin) / offset_w + 0.5);
        var y = Math.floor(255 * (cur_y - offset.top  - margin) / offset_h + 0.5);
        y = 255 - y;  // y is inverted: 255 is top, 0 is bottom

        // clamp
        x = Math.max(x, 0);
        y = Math.max(y, 0);
        x = Math.min(x, 255);
        y = Math.min(y, 255);

        return { 'x': x, 'y': y, 'button': cur_button };
    }

    return {
        'init': init,
        'state': getJoyState
    };

}());  // joystick

joystick = joystick;  // keep jshint happy

// vim:et:sw=4:
