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
// CRT
//============================================================================

// option flags for jslint:
/* global alert, ccemu, tms5501, smc5027, autotyper, uf6_rom, uf6_rom_lowercase */

var crt = (function () {

    'use strict';

    var canvasScale = 1.00;  // current canvas scaling factor
    var onscreen = {};       // onscreen canvas
    var offscreen;           // offscreen canvas
    var offscreen2;          // 2nd offscreen canvas
    var fontmap = [];        // precomputed fonts in all color combinations
    var dirtyBit = true;     // has the screen changed since the last blit?
    var phaseCursor = 0;     // blink cycle is 32 60Hz vsync's

    function init() {
        initCanvas();
        setCharset(0);
    }

    // find the display canvas and build an offscreen canvas
    function initCanvas() {
        if ($('#canv').length > 0) {
            onscreen = $('#canv')[0];
            onscreen.ctx = onscreen.getContext('2d');
            onscreen.width  = 384 * canvasScale;
            onscreen.height = 256 * canvasScale;

            // create offscreen canvas as backing store
            offscreen = document.createElement('canvas');
            offscreen.ctx = offscreen.getContext('2d');
            offscreen.width  = 384;
            offscreen.height = 256;

            // create another offscreen canvas; it holds the scrolled
            // version of the screen, then we draw the cursor on top of
            // it, then we blit it to the screen, possibly with scaling
            offscreen2 = document.createElement('canvas');
            offscreen2.ctx = offscreen2.getContext('2d');
            offscreen2.width  = 384;
            offscreen2.height = 256;
        }
    }

    // precompute image maps by folding in color information to the glyph
    // information.  Each displayed character is represented by two bytes:
    // an attribute byte, and a character code.  The attribute byte is
    // encoded as follows:
    //
    //     bit:         7     6      5     4     3     2     1     0
    //     meaning:  [plot][blink][bg-B][bg-G][bg-R][fg-B][fg-G][fg-R]
    //
    // That is,
    //    bits [2:0] specify the B,G,R colors for the foreground;
    //    bits [5:3] specify the B,G,R colors for the background;
    //    bit    [6] specifies blink mode (1.875 Hz)
    //    bit    [7] 0=normal character set, 1=plot mode
    //
    // the plot character set is fed by a rom, but to save space, we compute
    // it as it has a very regular pattern:
    //     +----+----+
    //     | 01 | 10 |
    //     +----+----+
    //     | 02 | 20 |
    //     +----+----+
    //     | 04 | 40 |
    //     +----+----+
    //     | 08 | 80 |
    //     +----+----+
    // Each cell above is drawn as a 3-wide, 2-high patch of display pixels.
    //
    // We create these font maps:
    //
    //   0: normal character map, 128 characters wide
    //   1: plot mode character map, 256 characters wide
    //   2: top half tall character map, 128 characters wide
    //   3: bottom half tall character map, 128 characters wide
    //
    // Each map has a glyph set stacked horizontally, and there
    // are 64 of these in each fg/bg combination, stacked 64 high.

    // 0=standard character set; 1=lowercase mod selected
    function setCharset(glyphset_idx) {

        var mapIdx, font;
        var fg_r, fg_g, fg_b;
        var bg_r, bg_g, bg_b;
        var charrow, bit, pix, off;
        var numChars;
        fontmap = [];

        if (glyphset_idx < 0 || glyphset_idx > 1) {
            alert("programming error: setCharset(idx) argument out of range");
        }

        var glyph_rom = (glyphset_idx) ? uf6_rom_lowercase : uf6_rom;

        // render text mode and plot mode
        for (var plot = 0; plot <= 1; plot++) {
            numChars = (plot) ? 256 : 128;
            // if in text mode, render normal and double high versions
            for (var dblhi = 0; dblhi < (plot ? 1 : 2); dblhi++) {
                // if in double high mode, render tops and bottoms
                for (var bottom = 0; bottom < (dblhi ? 2 : 1); bottom++) {

                    font = offscreen.ctx.createImageData(6*numChars, 8*64);

                    // cycle through all bg color variations
                    for (var bg = 0; bg < 8; bg++) {
                        bg_r = (bg & 1) ? 0xFF : 0x00;
                        bg_g = (bg & 2) ? 0xFF : 0x00;
                        bg_b = (bg & 4) ? 0xFF : 0x00;
                        // cycle through all fg color variations
                        for (var fg = 0; fg < 8; fg++) {
                            fg_r = (fg & 1) ? 0xFF : 0x00;
                            fg_g = (fg & 2) ? 0xFF : 0x00;
                            fg_b = (fg & 4) ? 0xFF : 0x00;
                            for (var ch = 0; ch < numChars; ch++) {
                                for (var cy = 0; cy < 8; cy++) {
                                    for (var cx = 0; cx < 6; cx++) {
                                        if (plot) {
                                            // compute plot character
                                            bit = (cy >> 1) + ((cx >= 3) ? 4 : 0);
                                            pix = (ch >> bit) & 1;
                                        } else {
                                            // use character gen rom
                                            charrow = (!dblhi) ? glyph_rom[8*ch + cy] :
                                                      (bottom) ? glyph_rom[8*ch + (cy >> 1) + 4] :
                                                                 glyph_rom[8*ch + (cy >> 1)];
                                            pix = (charrow >> (7 - cx)) & 1;
                                        }
                                        off = // offset to color pair
                                              (4*6 * numChars * 8*(8*bg + fg)) +
                                              // offset to row within character
                                              (4*6 * numChars * cy) +
                                              // offset to glyph
                                              (4*6 * ch) +
                                              // offset to pixel within glyph row
                                              (4 * cx);
                                        font.data[off + 0] = (pix) ? fg_r : bg_r;
                                        font.data[off + 1] = (pix) ? fg_g : bg_g;
                                        font.data[off + 2] = (pix) ? fg_b : bg_b;
                                        font.data[off + 3] = 0xff;  // alpha
                                    } // cx
                                }  // cy
                            } // ch(aracter)
                        } // fg color
                    } // bg color

                    // save the finished font
                    mapIdx = (plot)   ? 1 :
                             (!dblhi) ? 0 :
                             (bottom) ? 3 :
                                        2;

                    // convert imageData to an offscreen canvas, and render from that
                    fontmap[mapIdx] = document.createElement('canvas');
                    fontmap[mapIdx].width = font.width;
                    fontmap[mapIdx].height = font.height;
                    fontmap[mapIdx].getContext('2d').putImageData(font, 0, 0);

                } // bottom half of dblhi char
            } // dblhi
        } // plot mode
    }

    // force all character positions to be redrawn.
    // pass 'true' to repaint only those in a blink state.
    // scan the 0x6000-0x6FFF range to avoid triggering wait for hblank.
    function refreshDisplay(blinkers) {
        for (var a = 0x6000; a < 0x7000; a += 2) {
            if (!blinkers || (ccemu.rd(a + 1) & 0x40)) {
                updateChar(a);
            }
        }
    }

    // update the backing store as the result of a write to the display RAM
    function updateChar(addr) {

        if (!offscreen) {
            return;
        }

        // Update video memory
        var base = addr - 0x6000;   // 0x6... range to avoid wait for hblank
        // two bytes per char, 64 char/row
        var x = (base >> 1) & 0x3F;
        // 128 bytes per row, 32 rows
        var y = (base >> 7) & 0x1F;

        var pair = (addr & 0xFFFE);
        var ch = ccemu.rd(pair);
        var attrib = ccemu.rd(pair + 1);  // attribute byte

        var plot = ((attrib & 0x80) !== 0);
        var blink = ((attrib & 0x40) !== 0);

        var glyph = (plot) ? ch : (ch & 0x7F);
        var dblhi = (!plot && (ch & 0x80));

        if (blink && blinkOn()) {
            attrib &= ~0x7;  // force fg color to black
        }
        var color = (attrib & 0x3F);

        var mapIdx = (plot)   ? 1 :
                     (!dblhi) ? 0 :
                     (y & 1)  ? 3 :
                                2;

        var font = fontmap[mapIdx];

        // render to offscreen canvas
        offscreen.ctx.drawImage(font,
                                6*glyph, 8*color, // src left, top
                                6, 8,             // src w,h
                                6*x, 8*y,         // dst left, top
                                6, 8);            // dst w,h

        dirtyBit = true;
    }

    // splat from the offscreen canvas to the visible canvas.
    // the offscreen canvas doesn't know about scroll, so if
    // it is active, we have to put that into action here.
    function blitDisplay() {

        if (!dirtyBit) {
            // don't need to do anything if nothing has changed
            return;
        }

        var firstRow = smc5027.firstDisplayRow();
        if (firstRow === 0) {
            // no offset: just blast in one go
            offscreen2.ctx.drawImage(offscreen, 0, 0);
        } else {

            // scroll offset is in effect
            var scrnW = 6 * 64;  // screen width
            var scrnH = 8 * 32;  // screen height
            var srcTopY = firstRow * 8;
            var srcTopH = scrnH - srcTopY;

            // draw the top part of the CRT image
            offscreen2.ctx.drawImage(offscreen,
                                    0, srcTopY,      // src left,top
                                    scrnW, srcTopH,  // src w,h
                                    0, 0,            // dst left,top
                                    scrnW, srcTopH   // dst w,h
                                   );

            // draw the bottom part of the CRT display
            offscreen2.ctx.drawImage(offscreen,
                                    0, 0,            // src left,top
                                    scrnW, srcTopY,  // src w,h
                                    0, srcTopH,      // dst left,top
                                    scrnW, srcTopY   // dst w,h
                                   );
        }

        // draw the cursor on the backing store
        var cursorX = smc5027.cursorX();
        var cursorY = smc5027.cursorY();
        var doCursor = !blinkOn() &&
                       (cursorX < 64) && (cursorY < 32) &&
                       !autotyper.isRunning();
        cursorY = (cursorY - firstRow + 32) % 32;  // scroll adjustment
        if (doCursor) {
            offscreen2.ctx.fillStyle = 'rgba(255,255,255,1.0)';  // white
            offscreen2.ctx.fillRect(6*cursorX, 8*cursorY ,    6, 1);
            offscreen2.ctx.fillRect(6*cursorX, 8*cursorY + 7, 6, 1);
        }

        // draw our own download progress bar
        if (autotyper.isRunning()) {
            var cvW = offscreen2.width;
            var cvH = offscreen2.height;
            // draw the white rect behind
            var bgW = Math.floor(cvW * 0.50);
            var bgH = Math.floor(cvH * 0.05);
            var bgX = Math.floor((cvW - bgW)/2);
            var bgY = Math.floor((cvH - bgH)/2);
            offscreen2.ctx.fillStyle = 'rgba(255,255,255,1.0)';
            offscreen2.ctx.fillRect(bgX,bgY, bgW,bgH);
            // draw the green rect in front, slightly smaller
            var fgW = Math.floor(cvW * 0.485);
            var fgH = Math.floor(cvH * 0.035);
            var fgX = Math.floor((cvW - fgW)/2);
            var fgY = Math.floor((cvH - fgH)/2);
            offscreen2.ctx.fillStyle = 'rgba(0,255,0,1.0)';
            offscreen2.ctx.fillRect(fgX,fgY, fgW*autotyper.percentDone()/100.0,fgH);
        }

        // blast it to the visible canvas
        onscreen.ctx.drawImage(offscreen2,
                               0, 0, 384, 256,
                               0, 0, 384*canvasScale, 256*canvasScale);

        dirtyBit = false;
    }

    // when the cursor changes state, or if the crt cursor position changes,
    // we have to redraw even if no bytes have changed
    function markDirty() {
        dirtyBit = true;
    }

    function setCanvasSize(scaling) {
        canvasScale = scaling;
        onscreen.width  = Math.floor(384*canvasScale);
        onscreen.height = Math.floor(256*canvasScale);

        if (0 && (canvasScale === Math.floor(canvasScale))) {
            // scale with nearest sampling, instead of interpolation
            // it looks horrible except for integer scale factors
            onscreen.ctx.imageSmoothingEnabled = false;
            onscreen.ctx.mozImageSmoothingEnabled = false;
        } else {
            onscreen.ctx.imageSmoothingTrue = true;
            onscreen.ctx.mozImageSmoothingTrue = true;
        }
    }

    function getCanvasSize() {
        return [ onscreen.width, onscreen.height ];
    }

    // this is called every frame refresh period.
    // it is kind of a lie: vsync happens each field in the real hardware,
    // but i'm using here as if the display was progressive.
    // the hardware phase divides 60Hz vsync by 32 to produce the blink
    // signal, but because I'm doing 30 progressive redraws a second
    // (instead of 60 fields), we divide by 16, not 32.
    function vsync () {
        phaseCursor = (phaseCursor + 1) & 0xF;
        // we trigger this on the rising edge of blink
        if (phaseCursor % 16 === 0) {
            // TMS 5501 external sensor input.  It is driven off
            // the blink phase, although I don't know high or low.
            tms5501.triggerExternalSensor();
        }
        // curor+blinking chars change on rise and fall
        if (phaseCursor % 8 === 0) {
            refreshDisplay(true);
            markDirty();  // force blit
        }
        blitDisplay();     // blit if dirty
        autotyper.poll();  // check if there is something to send
    }

    function blinkOn() {
        return (phaseCursor >= 8);
    }

    // expose public members:
    return {
        'init':            init,
        'vsync':           vsync,
        'refreshDisplay':  refreshDisplay,
        'setCharset':      setCharset,
        'updateChar':      updateChar,
        'markDirty':       markDirty,
        'blitDisplay':     blitDisplay,
        'setCanvasSize':   setCanvasSize,
        'getCanvasSize':   getCanvasSize
    };

}());  // crt

// vim:et:sw=4:
