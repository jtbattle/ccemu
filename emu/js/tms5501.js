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
// TMS 5501 chip
//============================================================================

// option flags for jslint:
/* global alert, console */
/* global ccemu, cpu, keybrd, floppy */
/* global assert, floppy_dbg */

var tms5501 = (function () {

    'use strict';

    var debugging = 0;

    var rxdata = 0x00,     // serial rx data

        txdata = 0x00,     // serial tx data, buffered
        txdata2 = 0x00,    // serial tx data, in bit shifter
        txdataCount = 0,   // double buffer depth

        outport = 0x00,    // parallel output port

// FIXME: bit 2 is normally high when no data is being received
//        it is used to detect break status
        sstatus = 0x00,   // interrupt status:
                          //   bit 0: frame error
                          //   bit 1: overrun error
                          //   bit 2: serial rcvd
                          //   bit 3: rcv buffer loaded
                          //   bit 4: xmit buffer empty
                          //   bit 5: interrupt pending
                          //   bit 6: full bit detect
                          //   bit 7: start bit detect

        rate = 0x00,      // serial baud rate control
                          //   bit 0:  110 baud
                          //   bit 1:  150 baud
                          //   bit 2:  300 baud
                          //   bit 3: 1200 baud
                          //   bit 4: 2400 baud
                          //   bit 5: 4800 baud
                          //   bit 6: 9600 baud
                          //   bit 7: 0=one stop bit, 1=two stop bits

        intMask = 0x00,   // interrupt enable mask
                          //   bit 0: 1= enable timer #1 interrupt
                          //   bit 1: 1= enable timer #2 interrupt
                          //   bit 2: 1= enable interrupt external sensor
                          //             fires at 60 Hz (50 in europe)
                          //   bit 3: 1= enable timer #3 interrupt
                          //   bit 4: 1= enable serial rx interrupt
                          //   bit 5: 1= enable serial tx interrupt
                          //   bit 6: 1= enable timer #4 interrupt
                          //   bit 7: 1= enable timer #5 interrupt
                          //             (or parallel input,
                          //              depending on other mode bit)

        intStatus = 0x00, // interrupt pending flags (like intMask)
                          // not a CPU accessible register

        dscCmd = 0x00,    // discrete command

        period = [0x00, 0x00, 0x00, 0x00, 0x00], // counter (re)init value

        count = [0x00, 0x00, 0x00, 0x00, 0x00]; // current counter

    // power on reset
    function reset() {
        sstatus = 0x10;        // tx buffer is empty
        txdataCount = 0;
        rate = 0x00;
        intMask = 0x00;
        intStatus = 0x20;      // serial tx buffer empty interrupt
        dscCmd = 0x00;         // discrete command
        for (var i = 0; i < 5; ++i) {
            period[i] = 0x00;
            count[i] = 0x00;
        }
        setOutport(0x00);
    }

    // this should be called on the rising edge of the simulated
    // "SN" (external sensor) pin.
    // In the compucolor, this is wired to the blink counter timer
    // (50/60 Hz vertical sync divided by 32); it drives the real time clock.
    function triggerExternalSensor() {
        intStatus |= 0x04;
        checkInterruptStatus();
    }

    // The chip divides the system clock down internally to produce a
    // 64uS tick, causing the timers to count down.  The datasheet doesn't
    // explain how it derives the 64 uS clock, and the spec says that the
    // phi1/phi2 clock inputs can have a period ranging from 480 ns to
    // 2000 ns.  With a fixed ratio internal divider, this would mean that
    // the tick actually varies with clock input frequency.  I'm just going
    // to not model this aspect and require a call to this function every
    // 64 uS.
    function tick64us() {
        for (var i = 0; i < 5; ++i) {
            if (count[i] > 0x00) {
                count[i] -= 1;
                if (count[i] === 0x00) {
                    count[i] = period[i];
                    intStatus |= (i === 0) ? 0x01 :
                                 (i === 1) ? 0x02 :
                                 (i === 2) ? 0x08 :
                                 (i === 3) ? 0x40 :
                                             0x80;
                }
            }
        }
        // interrupt the CPU if any timers expired
        checkInterruptStatus();
    }

    // this gets called by the currently selected serial device
    // any time it receives a character
    function rxSerial(byteval, framingError) {
        // did we receive another byte before last one was picked up?
        var overrun = (sstatus >> 3) & 1;

        rxdata = byteval;

        // bit 7 is set high on start bit.
        // bit 6 is set when the first data bit is received.
        // we don't model at that level of granularity, though.
        // both are cleared when the full character is received.
        sstatus = (sstatus & 0x3E) |  // clear bits 7,6,0
                  ((framingError & 1) << 0) |  // conditionally set 0
                  (overrun << 1)            |  // overrun
                  (      1 << 3);              // rx buffer full

        intStatus |= 0x10; // serial rx interrupt
        checkInterruptStatus();
    }

    // because there are side effects of writing the parallel port,
    // it has been localized here
    function setOutport(value) {
        outport = value;
        var floppy_write   = ((value >> 3) & 1) === 1;
        var floppy_stepper = ((value >> 0) & 7);
        floppy[0].select(floppy0Selected(), floppy_write, floppy_stepper);
        floppy[1].select(floppy1Selected(), floppy_write, floppy_stepper);
    }
    function keyboardSelected() { return ((outport >> 4) & 3) === 0; }
    function floppy0Selected()  { return ((outport >> 4) & 3) === 1; }
    function floppy1Selected()  { return ((outport >> 4) & 3) === 2; }

    // this is called when the currently selected serial device
    // when it has disposed of the most recently sent txdata byte
    // TBD: the 5501 manual mentions that bit 5 of the interrupt mask
    //      corresponds to "tx buffer emptied" -- it sounds like it
    //      is set only on transition from full to empty, but then
    //      it is unclear when intStatus[5] gets cleared.  for now,
    //      it is implemented as if it is the same as xmit buffer empty.
    function txSerialReady() {
        assert(txdataCount > 0,
               'txSerialReady() called with txdataCount == 0');
        txdataCount--;
        // if the buffer is full, move it to the shifter
        if (txdataCount === 1) {
            if (0 && floppy_dbg) {
                console.log('txSerialReady() is shifting buffered byte at T=' + ccemu.getTickCount());
            }
            txdata2 = txdata;
            if (floppy0Selected()) {
                floppy[0].txData(txdata2);
            } else if (floppy1Selected()) {
                floppy[1].txData(txdata2);
            }
        }

        sstatus |= 0x10;       // xmit buffer empty
        intStatus |= 0x20;     // serial character sent
        checkInterruptStatus();
    }

    // read a device register
    function rd(port) {
        var retval;

        switch (port) {
        // read serial data in from J-2
        case 0x0:
            retval = rxdata;
            sstatus &= ~0x08;    // clear bit 3: rx buffer full
            intStatus &= ~0x10;  // clear serial rx buffer full
            checkInterruptStatus();
            if (0 && floppy_dbg) {
                console.log('T' + ccemu.getTickCount() +
                            ':: 8080 read serial data ' + retval.toString(16) +
                            ' @pc=' + cpu.pc.toString(16) +
                            ' caller=' + (cpu.ram[cpu.sp] + 256*cpu.ram[cpu.sp+1]).toString(16)
                           );
            }
            break;

        // read parallel input port
        case 0x1:
            if (keyboardSelected()) {
                // data from keyboard connection J-1
                var op = outport;
                retval = (op & 0x80) ? keybrd.matrix(16) :
                                       keybrd.matrix(op & 0xF);
            } else if (floppy0Selected()) {
                // data from selected floppy disk CD0:
                retval = floppy[0].getStatus();
            } else if (floppy1Selected()) {
                // data from selected floppy disk CD0:
                retval = floppy[1].getStatus();
            } else {
                // == 3 is ??
                retval = 0x00; // FIXME: not modeled
            }
            break;

        // read interrupt address on TMS 5501; clear after reading
        case 0x2:
            retval = getIntAddr();
            if (retval) {
                clearIntAddr(retval);
            } else {
                retval = 0x00;
            }
            break;

        // read status
        case 0x3:
            // bit 5 indicates if there is an unmasked interrupt pending
            retval = (sstatus & ~0x20) |
                     ((intMask & intStatus) ? 0x20 : 0x00);
            if (0 && floppy_dbg) {
                console.log('T' + ccemu.getTickCount() +
                            ':: 8080 read 5501 status(3): bit3=' + ((retval>>3) & 1) +
                            ' @pc=' + cpu.pc.toString(16) +
                            ' caller=' + (cpu.ram[cpu.sp] + 256*cpu.ram[cpu.sp+1]).toString(16)
                           );
            }
            // reading the status register clears the serial overrun flag
            sstatus &= ~0x02;  // clear bit 1
            break;

        // set baud rate on J-2 serial I/O
        case 0x5:
            retval = rate;
            break;

        // load interrupt mask register
        case 0x8:
            retval = intMask;
            break;

        // load interval timers:
        case 0x9:
        case 0xa:
        case 0xb:
        case 0xc:
        case 0xd:
            retval = period[port - 0x9];
            break;

        default:
            // write-only register or no function
            retval = 0x00;
            break;
        }

        return retval;
    }

    // write a device register
    function wr(port, value) {

        switch (port) {

        // issue discrete command
        case 0x4:
            dscCmd = value;
            if (value & 0x01) {
                // reset status
                sstatus &= 0x35;  // clear bits 7,6,3,1
                // FIXME: serial transmit is set to high (marking)
                //        but it doesn't affect the tx buffer itself
                // the interrupt reg is cleared,
                // except tx buffer empty is set high
                intStatus = 0x20;  // tx buffer empty interrupt
            }
            if (value & 0x03 === 0x02) {
                // serial tx break
                // FIXME: not modeled
                assert(!debugging, 'serial tx requests a line break');
            }
            // bit 2: interrupt 7 select
            // FIXME: I assume this is only programmed to 0 (use timer #5)
            //        not data input bit 7 L->H transition as interrupt
            //        trigger
            // bit 3: interrupt acknowledge enable
            //        1=accept int ack
            //        0=ignore int ack
            //        FIXME: should this be modeled?
            // bit 4: test control; normally low
            // bit 5: test control; normally low
            // bit 6: unused
            // bit 7: unused
            break;

        // set baud rate on J-2 serial I/O
        case 0x5:
            rate = value;
            break;

        // transmit serial data out to J-2
        // TBD: do we need to model a 1 deep fifo?  that is a tx buffer
        //      register and a serial register?  if not, it imposes a
        //      strict timing requirement on the 8080 to stuff the next
        //      byte very quickly to prevent gaps between bytes.
        //      the existing
        case 0x6:
            if (0 && floppy_dbg) {
                console.log('T' + ccemu.getTickCount() +
                            ':: 8080 sending serial data ' + value.toString(16) +
                            ' @pc=' + cpu.pc.toString(16) +
                            ' caller=' + (cpu.ram[cpu.sp] + 256*cpu.ram[cpu.sp+1]).toString(16)
                           );
            }

            // but it in the buffer
            txdata = value;
            txdataCount++;

            if (txdataCount === 3) {
                // ignore the fact the tx buffer got clobbered
                assert(!debugging, 'txdata buffer got clobbered');
                txdataCount = 2;
            }
            if (txdataCount === 2) {
                sstatus &= ~0x10;       // !xmit buffer empty
                intStatus &= ~0x20;     // !serial character sent
            }
            if (txdataCount === 1) {
                // send it immediately to the shift register
                if (0 && floppy_dbg) {
                    console.log('5501 wr() is sending txdata at T=' + ccemu.getTickCount());
                }
                txdata2 = txdata;
                if (floppy0Selected()) {
                    floppy[0].txData(txdata2);
                } else if (floppy1Selected()) {
                    floppy[1].txData(txdata2);
                }
            }
            checkInterruptStatus();
            break;

        // transmit parallel data on connection J-1 (also controls disk R/W)
        // looking at the floppy schematic,
        //   b4 = floppy 0 select
        //   b5 = floppy 1 select
        //   b6 = floppy 2 select
        //   b7 = floppy 3 select
        // but this contradicts the keyboard decoding, so I must be confused
        case 0x7:
            setOutport(value);
            break;

        // load interrupt mask register
        case 0x8:
            intMask = value;
            checkInterruptStatus();
            break;

        // load interval timers:
        case 0x9:
        case 0xa:
        case 0xb:
        case 0xc:
        case 0xd:
            period[port - 0x9] = value;
            count[port - 0x9] = value;
            // if value=0, set interrupt immediately
            if (value === 0) {
                intStatus |= (port === 0x9) ? 0x01 :
                             (port === 0xA) ? 0x02 :
                             (port === 0xB) ? 0x08 :
                             (port === 0xC) ? 0x40 :
                                              0x80;
                checkInterruptStatus();
            }
            break;

        // read-only register or no function
        default:
            break;
        }
    }

    // interrupt priority in descending order:
    //     1st -- interval timer #1
    //     2nd -- interval timer #2
    //     3rd -- external sensor
    //     4th -- interval timer #3
    //     5th -- receive buffer loaded
    //     6th -- transmit buffer emptied
    //     7th -- interval timer #4
    //     8th -- interval timer #5 / or external input XI 7
    function getIntAddr() {
        var masked = (intStatus & intMask);
        var rstOp = (masked & 0x01) ? 0xC7 :   // RST 0
                    (masked & 0x02) ? 0xCF :   // RST 1
                    (masked & 0x04) ? 0xD7 :   // RST 2
                    (masked & 0x08) ? 0xDF :   // RST 3
                    (masked & 0x10) ? 0xE7 :   // RST 4
                    (masked & 0x20) ? 0xEF :   // RST 5
                    (masked & 0x40) ? 0xF7 :   // RST 6
                    (masked & 0x80) ? 0xFF :
                                      undefined;
        return rstOp;
    }

    // clear an interrupt bit on interrupt ack, or when polled
    function clearIntAddr(op) {
        intStatus &= (op === 0xC7) ? ~0x01 :
                     (op === 0xCF) ? ~0x02 :
                     (op === 0xD7) ? ~0x04 :
                     (op === 0xDF) ? ~0x08 :
                     (op === 0xE7) ? ~0x10 :
                     (op === 0xEF) ? ~0x20 :
                     (op === 0xF7) ? ~0x40 :
                     (op === 0xFF) ? ~0x80 :
                                      0xFF;
    }

    // FIXME: this is called only when some state has changed
    //        however, if we request an interrupt and the 8080
    //        returns false to takeInterrupt() because interrupts are
    //        disabled, we should retry every cycle until either the
    //        interrupt conditions is cleared or the 8080 accepts it.
    function checkInterruptStatus() {
        if (intStatus & intMask) {
            var rstOp = getIntAddr();
            if (rstOp) {
                if (cpu.takeInterrupt(rstOp)) {
                    clearIntAddr(rstOp);
                }
            }
        }
    }

    // expose public members:
    return {
        'reset':                  reset,
        'rd':                     rd,
        'wr':                     wr,
        'tick64us':               tick64us,
        'rxSerial':               rxSerial,
        'txSerialReady':          txSerialReady,
        'triggerExternalSensor':  triggerExternalSensor
    };

}());  // tms5501

// vim:et:sw=4:
