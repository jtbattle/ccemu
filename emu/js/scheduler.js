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
// event scheduler based on the 8080 clock
//============================================================================
// This is a simple event scheduler which performs callbacks based on 8080
// clock ticks, not the realtime clock.
//
// There are two types of timers that can be created:
//     var foo = scheduler.oneShot(number_of_ticks, callback);
//     var foo = scheduler.periodic(number_of_ticks, callback);
//
// As the name implies, the first one triggers after the specified number
// of ticks have elapsed, and the second one repeats with the specified
// period.  Either type of timer can be cancelled like this:
//     foo.cancel();

// option flags for jslint:
/* global alert, assert */
/* global ccemu */

var scheduler = (function () {

    'use strict';

    // timer objects contain a serial number to tell them apart
    var sn = 0;
    // table of all active timers
    var timers = [];
    // table of dead timer serial numbers
    var deadList = [];
// for debugging:
    var liveList = [];

    function makeTimer(ticks, periodic, callback, name) {
        var serialNumber;
        if (deadList.length === 0) {
            serialNumber = sn++;
        } else {
            serialNumber = deadList.pop();
        }
        assert(liveList[serialNumber] === undefined);
        liveList[serialNumber] = serialNumber;
        var timer = {
            name: name,  // debugging aid
            start: ccemu.getTickCount(),
            periodic: periodic,
            phase: 0,
            limit: ticks,
            cbfcn: callback
        };
        timers[serialNumber] = timer;
        return {
            id: serialNumber,
            age: function () { return ccemu.getTickCount() - timer.start; },
            cancel: (function () {
                var myid = serialNumber;  // capture id in closure
                return function () { scheduler.cancel(myid); };
            }())
        };
    }

    function oneShot(ticks, callback, name) {
        return makeTimer(ticks, false, callback, name);
    }

    function periodic(ticks, callback, name) {
        return makeTimer(ticks, true, callback, name);
    }

    function cancel(sernum) {
        if (timers[sernum] === undefined) {
            alert("Error: attempted to free timer #" + sernum);
            return;
        }
        liveList[sernum] = undefined;
        deadList.push(sernum);
        timers[sernum] = undefined;
    }

    // FIXME:
    // this is a very dumb implementation.  a smart implementation would
    // just cache the tick count of the soonest to expire timer and work
    // that scalar variable until it expired, then it would go through
    // the timer list and debit all the timers, vs sweeping through the
    // timer array on every call.
    function tick(ticks) {
        var len = timers.length;
        for (var t = 0; t < len; t++) {
            var tmr = timers[t];
            if (tmr !== undefined) {
                tmr.phase += ticks;
                if (tmr.phase >= tmr.limit) {
                    tmr.phase -= tmr.limit;
                    tmr.cbfcn();
                    if (!tmr.periodic) {
                        cancel(t);
                    }
                }
            }
        }
    }

    // expose public members:
    return {
        // timer management
        'oneShot': oneShot,
        'periodic': periodic,
        'cancel': cancel,
        // how the scheduler is informed of the passage of time
        'tick': tick
    };
}());

// vim:et:sw=4:
