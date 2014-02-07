// Copyright (C) 2008 Chris Double.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES,
// INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
// FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
// DEVELOPERS AND CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
// PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS;
// OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
// WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
// OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
// ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

// js8080 original by Chris Double (http://www.bluishcoder.co.nz/js8080/)
//        modified by Stefan Tramm, 2010 (http://www.tramm.li/i8080/)
//        modified by Jim Battle, 2013-2014 (http://www.compucolor.org)

function pad(str, n) {
  var r = [];
  for(var i=0; i < (n - str.length); ++i)
    r.push("0");
  r.push(str);
  return r.join("");
};

function Cpu(raw_ram, rd_func, wr_func, input_func, output_func, intvec_func)
{
  // cache/localize resource accessor functions
  this.ram    = raw_ram;      // should only be used by the disassembler
  this.rd     = rd_func;
  this.wr     = wr_func;
  this.input  = input_func;
  this.output = output_func;
  this.intvec = intvec_func;
  this.reset();
}

// CPU flag mask bits
Cpu.CARRY     = 0x01;
Cpu.PARITY    = 0x04;
Cpu.HALFCARRY = 0x10;
Cpu.ZERO      = 0x40;
Cpu.SIGN      = 0x80;

Cpu.prototype.reset = function () {
  this.b = 0;
  this.c = 0;
  this.d = 0;
  this.e = 0;
  this.f = 0;
  this.h = 0;
  this.l = 0;
  this.a = 0;
  this.pc = 0;
  this.sp = 0x0000;
  this.halted = false;
  this.intenable = false;
  this.intpending = false;
};

Cpu.prototype.af = function() {
  // according to the intel 8080 programmer's manual (p. 22)
  // bit 1 is always 1, while bits 3 and 5 are always 0
  var flags = (this.f & 0xd7) | 0x02;
  return this.a << 8 | flags;
};

Cpu.prototype.AF = function(n) {
  this.a = n >> 8 & 0xFF;
  this.f = n & 0xFF;
};

Cpu.prototype.bc = function () {
  return this.b << 8 | this.c;
};

Cpu.prototype.BC = function(n) {
  this.b = n >> 8 & 0xFF;
  this.c = n & 0xFF;
};

Cpu.prototype.de = function () {
  return this.d << 8 | this.e;
};

Cpu.prototype.DE = function(n) {
  this.d = n >> 8 & 0xFF;
  this.e = n & 0xFF;
};

Cpu.prototype.hl = function () {
  return this.h << 8 | this.l;
};

Cpu.prototype.HL = function(n) {
  this.h = n >> 8 & 0xFF;
  this.l = n & 0xFF;
};

Cpu.prototype.toString = function() {
  return "{" +
    " af: " + pad(this.af().toString(16),4) +
    " bc: " + pad(this.bc().toString(16),4) +
    " de: " + pad(this.de().toString(16),4) +
    " hl: " + pad(this.hl().toString(16),4) +
    " pc: " + pad(this.pc.toString(16),4) +
    " sp: " + pad(this.sp.toString(16),4) +
    " flags: " +
    (this.f & Cpu.ZERO ? "z" : ".") +
    (this.f & Cpu.SIGN ? "s" : ".") +
    (this.f & Cpu.PARITY ? "p" : ".") +
    (this.f & Cpu.CARRY ? "c" : ".") +
    " " + this.disassemble1(this.pc)[1] +
    " }";
};

Cpu.prototype.cpuStatus = function() {
  var s = "";
  s += " AF:"+pad(this.af().toString(16),4);
  s += " " +
       (this.f & Cpu.SIGN ? "s" : ".") +
       (this.f & Cpu.ZERO ? "z" : ".") +
       (this.f & Cpu.HALFCARRY ? "h" : ".") +
       (this.f & Cpu.PARITY ? "p" : ".") +
       (this.f & Cpu.CARRY ? "c" : ".");
  s += " BC:"+pad(this.bc().toString(16),4);
  s += " DE:"+pad(this.de().toString(16),4);
  s += " HL:"+pad(this.hl().toString(16),4);
  s += " (HL):"+pad(this.rd(this.hl()).toString(16),2);
  s += " SP:"+pad(this.sp.toString(16),4);
  s += " PC:"; //+pad(this.pc.toString(16),4);
  s += (this.intenable ? "  IE" : " !IE");
  s += this.disassemble1(this.pc)[1];
  return s;
};

Cpu.prototype.halted = function() {
  return this.halted;
};

// Step through one instruction
Cpu.prototype.step = function() {
  var i = this.rd(this.pc++);
  this.pc &= 0xFFFF;
  var r = this.execute(i);
  return r;
};

Cpu.prototype.writePort = function (port, v) {
  this.output(port, v);
  return this;
};

Cpu.prototype.readPort = function (port) {
  return this.input(port);
};

Cpu.prototype.getByte = function (addr) {
  return this.rd(addr);
};

Cpu.prototype.getWord = function (addr) {
  var l = this.rd(addr);
  var h = this.rd(addr+1);
  return h << 8 | l;
};

Cpu.prototype.nextByte = function() {
  var b = this.rd(this.pc++);
  this.pc &= 0xFFFF;
  return b;
};

Cpu.prototype.nextWord = function() {
  var pc = this.pc;
  var l = this.rd(pc++);
  var h = this.rd(pc++);
  this.pc = pc & 0xFFFF;
  return h << 8 | l;
};

Cpu.prototype.writeByte = function(addr, value) {
  var v = value & 0xFF;
  this.wr(addr, v);
  return this;
};

Cpu.prototype.writeWord = function(addr, value) {
  var l = value;
  var h = value >> 8;
  this.writeByte(addr, l);
  this.writeByte(addr+1, h);
  return this;
};

// use this for address arithmetic
Cpu.prototype.add = function(a, b) {
  return (a + b) & 0xffff;
};

// set flags after arithmetic and logical ops
Cpu.prototype.calcFlags = function(v, lhs, rhs) {
  var x = v & 0xFF;

  // calc parity (see Henry S. Warren "Hackers Delight", page 74)
  var y = x ^ (x >> 1);
  y ^= y >> 2;
  y ^= y >> 4;

  if (y & 1)
    this.f &= ~Cpu.PARITY & 0xFF; // PO
  else
    this.f |= Cpu.PARITY; // PE

  if (v & 0x80)
    this.f |= Cpu.SIGN;
  else
    this.f &= ~Cpu.SIGN & 0xFF;

  if (x)
    this.f &= ~Cpu.ZERO & 0xFF;
  else
    this.f |= Cpu.ZERO;

  if (((rhs ^ v) ^ lhs) & 0x10)
    this.f |= Cpu.HALFCARRY;
  else
    this.f &= ~Cpu.HALFCARRY & 0xFF;

  if (v >= 0x100 || v < 0)
    this.f |= Cpu.CARRY;
  else
    this.f &= ~Cpu.CARRY & 0xFF;

  return x;
};

Cpu.prototype.incrementByte = function(o) {
  var c = this.f & Cpu.CARRY; // carry isnt affected
  var r = this.calcFlags(o+1, o, 1);
  this.f = (this.f & ~Cpu.CARRY & 0xFF) | c;
  return r;
};

Cpu.prototype.decrementByte = function(o) {
  var c = this.f & Cpu.CARRY; // carry isnt affected
  var r = this.calcFlags(o-1, o, 1);
  this.f = (this.f & ~Cpu.CARRY & 0xFF) | c;
  return r;
};

Cpu.prototype.addByte = function(lhs, rhs) {
  return this.calcFlags(lhs + rhs, lhs, rhs);
};

Cpu.prototype.addByteWithCarry = function(lhs, rhs) {
  return this.addByte(lhs, rhs + ((this.f & Cpu.CARRY) ? 1 : 0));
};

Cpu.prototype.subtractByte = function(lhs, rhs) {
  return this.calcFlags(lhs - rhs, lhs, rhs);
};

Cpu.prototype.subtractByteWithCarry = function(lhs, rhs) {
  return this.subtractByte(lhs, rhs + ((this.f & Cpu.CARRY) ? 1 : 0));
};

Cpu.prototype.andByte = function(lhs, rhs) {
  var x = this.calcFlags(lhs & rhs, lhs, rhs);
  this.f &= ~(Cpu.HALFCARRY) & 0xFF;
  if ((lhs | rhs) & 0x08) {
    this.f |= Cpu.HALFCARRY;
  }
  this.f &= ~Cpu.CARRY & 0xFF;
  return x;
};

Cpu.prototype.xorByte = function(lhs, rhs) {
  var x = this.calcFlags(lhs ^ rhs, lhs, rhs);
  this.f &= ~Cpu.HALFCARRY & 0xFF;
  this.f &= ~Cpu.CARRY & 0xFF;
  return x;
};

Cpu.prototype.orByte = function(lhs, rhs) {
  var x = this.calcFlags(lhs | rhs, lhs, rhs);
  this.f &= ~Cpu.HALFCARRY & 0xFF;
  this.f &= ~Cpu.CARRY & 0xFF;
  return x;
};

Cpu.prototype.addWord = function(lhs, rhs) {
  var r = lhs + rhs;
  if (r > 0xFFFF)
    this.f |= Cpu.CARRY;
  else
    this.f &= ~Cpu.CARRY & 0xFF;
  return r & 0xFFFF;
};

Cpu.prototype.pop = function() {
  var pc = this.getWord(this.sp);
  this.sp = (this.sp + 2) & 0xFFFF;
  return pc;
};

Cpu.prototype.push = function(v) {
  this.sp = (this.sp - 2) & 0xFFFF;
  this.writeWord(this.sp, v);
};

// on interrupt, the interrupting device has to supply an interrupt
// vector (in real life, it could supply any one byte instruction,
// but typically it is an "RST n" operation.
Cpu.prototype.irq = function(req) {
  this.intpending = req;
}

// execute one instruction, and returns the number of cycles it took
Cpu.prototype.execute = function(i) {
  var cycles, op;
  if (this.intpending && this.intenable) {
    // take an interrupt
    this.halted = false;
    this.intenable = false;  // disable interrupt
    // the routine which called this one has already incremented the PC.
    // undo it so it will be fetched again after the ISR.
    this.pc = (this.pc - 1) & 0xFFFF;
    // this.intpending isn't automatically cleared because it is the job of
    // intvec() to evalute if more interrupts are pending and call cpu.irq()
    // with the new status
    op = this.intvec();         // fetch RST n
    cycles = this.execute(op);  // do it
  } else if (this.halted) {
    // just burn time until either reset or an interrupt
    cycles = 4;
  } else switch(i) {
  case 0x00:
    {
      // NOP
      cycles = 4;
    }
    break;
  case 0x01:
    {
      // LD BC,nn
      this.BC(this.nextWord());
      cycles = 10;
    }
    break;
  case 0x02:
    {
      // LD (BC),A
      this.writeByte(this.bc(), this.a);
      cycles = 7;
    }
    break;
  case 0x03:
    {
      // INC BC
      this.BC((this.bc() + 1) & 0xFFFF);
      cycles = 6;
    }
    break;
  case 0x04:
    {
      // INC  B
      this.b = this.incrementByte(this.b);
      cycles = 5;
    }
    break;
  case 0x05:
    {
      // DEC  B
      this.b = this.decrementByte(this.b);
      cycles = 5;
    }
    break;
  case 0x06:
    {
      // LD   B,n
      this.b = this.nextByte();
      cycles = 7;
    }
    break;
  case 0x07:
    {
      // RLCA
      var l = (this.a & 0x80) >> 7;
      if (l)
	this.f |= Cpu.CARRY;
      else
	this.f &= ~Cpu.CARRY & 0xFF;

      this.a = ((this.a << 1) & 0xFE) | l;
      cycles = 4;
    }
    break;
  case 0x09:
    {
      // ADD  HL,BC
      this.HL(this.addWord(this.hl(), this.bc()));
      cycles = 11;
    }
    break;
  case 0x0A:
    {
      // LD   A,(BC)
      this.a = this.rd(this.bc());
      cycles = 7;
    }
    break;
  case 0x0B:
    {
      // DEC  BC
      this.BC((this.bc() - 1) & 0xFFFF);
      cycles = 6;
    }
    break;
  case 0x0C:
    {
      // INC  C
      this.c = this.incrementByte(this.c);
      cycles = 5;
    }
    break;
  case 0x0D:
    {
      // DEC  C
      this.c = this.decrementByte(this.c);
      cycles = 5;
    }
    break;
  case 0x0E:
    {
      // LD   C,n
      this.c = this.nextByte();
      cycles = 7;
    }
    break;
  case 0x0F:
    {
      // RRCA
      var h = (this.a & 1) << 7;
      if (h)
	this.f |= Cpu.CARRY;
      else
	this.f &= ~Cpu.CARRY & 0xFF;

      this.a = ((this.a >> 1) & 0x7F) | h;
      cycles = 4;
    }
    break;
  case 0x11:
    {
      // LD   DE,nn
      this.DE(this.nextWord());
      cycles = 10;
    }
    break;
  case 0x12:
    {
      // LD   (DE),A
      this.writeByte(this.de(), this.a);
      cycles = 7;
    }
    break;
  case 0x13:
    {
      // INC  DE
      this.DE((this.de() + 1) & 0xFFFF);
      cycles = 6;
    }
    break;
  case 0x14:
    {
      // INC  D
      this.d = this.incrementByte(this.d);
      cycles = 5;
    }
    break;
  case 0x15:
    {
      // DEC  D
      this.d = this.decrementByte(this.d);
      cycles = 5;
    }
    break;
  case 0x16:
    {
      // LD   D,n
      this.d = this.nextByte();
      cycles = 7;
    }
    break;
  case 0x17:
    {
      // RLA
      var c = (this.f & Cpu.CARRY) ? 1 : 0;
      if(this.a & 0x80)
	this.f |= Cpu.CARRY;
      else
	this.f &= ~Cpu.CARRY & 0xFF;
      this.a = ((this.a << 1) & 0xFE) | c;
      cycles = 4;
    }
    break;
  case 0x19:
    {
      // ADD  HL,DE
      this.HL(this.addWord(this.hl(), this.de()));
      cycles = 11;
    }
    break;
  case 0x1A:
    {
      // LD   A,(DE)
      this.a = this.rd(this.de());
      cycles = 7;
    }
    break;
  case 0x1B:
    {
      // DEC  DE
      this.DE((this.de() - 1) & 0xFFFF);
      cycles = 6;
    }
    break;
  case 0x1C:
    {
      // INC  E
      this.e = this.incrementByte(this.e);
      cycles = 5;
    }
    break;
  case 0x1D:
    {
      // DEC  E
      this.e = this.decrementByte(this.e);
      cycles = 5;
    }
    break;
  case 0x1E:
    {
      // LD   E,n
      this.e = this.nextByte();
      cycles = 7;
    }
    break;
  case 0x1F:
    {
      // RRA
      var c = (this.f & Cpu.CARRY) ? 0x80 : 0;
      if(this.a & 1)
	this.f |= Cpu.CARRY;
      else
	this.f &= ~Cpu.CARRY & 0xFF;
      this.a = ((this.a >> 1) & 0x7F) | c;
      cycles = 4;
    }
    break;
  case 0x21:
    {
      // LD   HL,nn
      this.HL(this.nextWord());
      cycles = 10;
    }
    break;
  case 0x22:
    {
      // LD   (nn),HL
      this.writeWord(this.nextWord(), this.hl());
      cycles = 16;
    }
    break;
  case 0x23:
    {
      // INC  HL
      this.HL((this.hl() + 1) & 0xFFFF);
      cycles = 6;
    }
    break;
  case 0x24:
    {
      // INC  H
      this.h = this.incrementByte(this.h);
      cycles = 5;
    }
    break;
  case 0x25:
    {
      // DEC  H
      this.h = this.decrementByte(this.h);
      cycles = 5;
    }
    break;
  case 0x26:
    {
      // LD   H,n
      this.h = this.nextByte();
      cycles = 7;
    }
    break;
  case 0x27:
    {
      // DAA -- algorithm taken from Eric Smith's "ksim.c" (brouhaha.com)
      var adjust = 0x00;
      var nib0 = (this.a & 0xf);
      var nib1 = (this.a >> 4);

      if ((nib0 > 9) || (this.f & Cpu.HALFCARRY))
	adjust = 0x06;
      if ((nib1 > 9) ||
          (this.f & Cpu.CARRY) ||
          ((nib1 === 9) && ((this.f & Cpu.CARRY) || (nib0 > 9))))
	adjust |= 0x60;

      var new_ac = (nib0 >= 0xa);
      var new_cy = (((nib1 >= 9) && (nib0 >= 10)) || (nib1 >= 10));

      this.a = this.calcFlags(this.a + adjust, this.a, adjust);

      if (new_ac)
	this.f |= Cpu.HALFCARRY;
      else
	this.f &= ~Cpu.HALFCARRY & 0xFF;

      if (new_cy)
	this.f |= Cpu.CARRY;
      else
	this.f &= ~Cpu.CARRY & 0xFF;

      cycles = 4;
    }
    break;
  case 0x29:
    {
      // ADD  HL,HL
      this.HL(this.addWord(this.hl(), this.hl()));
      cycles = 11;
    }
    break;
  case 0x2A:
    {
      // LD   HL,(nn)
      this.HL(this.getWord(this.nextWord()));
      cycles = 16;
    }
    break;
  case 0x2B:
    {
      // DEC  HL
      this.HL((this.hl() - 1) & 0xFFFF);
      cycles = 6;
    }
    break;
  case 0x2C:
    {
      // INC  L
      this.l = this.incrementByte(this.l);
      cycles = 5;
    }
    break;
  case 0x2D:
    {
      // DEC  L
      this.l = this.decrementByte(this.l);
      cycles = 5;
    }
    break;
  case 0x2E:
    {
      // LD   L,n
      this.l = this.nextByte();
      cycles = 7;
    }
    break;
  case 0x2F:
    {
      // CPL
      this.a ^= 0xFF;
      cycles = 4;
    }
    break;
  case 0x31:
    {
      // LD   SP,nn
      this.sp = this.nextWord();
      cycles = 10;
    }
    break;
  case 0x32:
    {
      // LD   (nn),A
      this.writeByte(this.nextWord(), this.a);
      cycles = 13;
    }
    break;
  case 0x33:
    {
      // INC  SP
      this.sp = ((this.sp + 1) & 0xFFFF);
      cycles = 6;
    }
    break;
  case 0x34:
    {
      // INC  (HL)
      var addr = this.hl();
      this.writeByte(addr, this.incrementByte(this.rd(addr)));
      cycles = 10;
    }
    break;
  case 0x35:
    {
      // DEC  (HL)
      var addr = this.hl();
      this.writeByte(addr, this.decrementByte(this.rd(addr)));
      cycles = 10;
    }
    break;
  case 0x36:
    {
      // LD   (HL),n
      this.writeByte(this.hl(), this.nextByte());
      cycles = 10;
    }
    break;
  case 0x37:
    {
      // SCF
      this.f |= Cpu.CARRY;
      cycles = 4;
    }
    break;
  case 0x39:
    {
      // ADD  HL,SP
      this.HL(this.addWord(this.hl(), this.sp));
      cycles = 11;
    }
    break;
  case 0x3A:
    {
      // LD   A,(nn)
      this.a = this.rd(this.nextWord());
      cycles = 13;
    }
    break;
  case 0x3B:
    {
      // DEC  SP
      this.sp = (this.sp - 1) & 0xFFFF;
      cycles = 6;
    }
    break;
  case 0x3C:
    {
      // INC  A
      this.a = this.incrementByte(this.a);
      cycles = 5;
    }
    break;
  case 0x3D:
    {
      // DEC  A
      this.a = this.decrementByte(this.a);
      cycles = 5;
    }
    break;
  case 0x3E:
    {
      // LD   A,n
      this.a = this.nextByte();
      cycles = 7;
    }
    break;
  case 0x3F:
    {
      // CCF
      this.f ^= Cpu.CARRY; //~CARRY & 0xFF;
      cycles = 4;
    }
    break;
  case 0x40:
    {
      // LD   B,B
      this.b = this.b;
      cycles = 5;
    }
    break;
  case 0x41:
    {
      //LD   B,C
      this.b = this.c;
      cycles = 5;
    }
    break;
  case 0x42:
    {
      // LD   B,D
      this.b = this.d;
      cycles = 5;
    }
    break;
  case 0x43:
    {
      // LD   B,E
      this.b = this.e;
      cycles = 5;
    }
    break;
  case 0x44:
    {
      // LD   B,H
      this.b = this.h;
      cycles = 5;
    }
    break;
  case 0x45:
    {
      // LD   B,L
      this.b = this.l;
      cycles = 5;
    }
    break;
  case 0x46:
    {
      // LD   B,(HL)
      this.b = this.rd(this.hl());
      cycles = 7;
    }
    break;
  case 0x47:
    {
      // LD   B,A
      this.b = this.a;
      cycles = 5;
    }
    break;
  case 0x48:
    {
      // LD   C,B
      this.c = this.b;
      cycles = 5;
    }
    break;
  case 0x49:
    {
      // LD   C,C
      this.c = this.c;
      cycles = 5;
    }
    break;
  case 0x4A:
    {
      // LD   C,D
      this.c = this.d;
      cycles = 5;
    }
    break;
  case 0x4B:
    {
      // LD   C,E
      this.c = this.e;
      cycles = 5;
    }
    break;
  case 0x4C:
    {
      // LD   C,H
      this.c = this.h;
      cycles = 5;
    }
    break;
  case 0x4D:
    {
      // LD   C,L
      this.c = this.l;
      cycles = 5;
    }
    break;
  case 0x4E:
    {
      // LD   C,(HL)
      this.c = this.rd(this.hl());
      cycles = 7;
    }
    break;
  case 0x4F:
    {
      // LD   C,A
      this.c = this.a;
      cycles = 5;
    }
    break;
  case 0x50:
    {
      // LD   D,B
      this.d = this.b;
      cycles = 5;
    }
    break;
  case 0x51:
    {
      // LD   D,C
      this.d = this.c;
      cycles = 5;
    }
    break;
  case 0x52:
    {
      // LD   D,D
      this.d = this.d;
      cycles = 5;
    }
    break;
  case 0x53:
    {
      // LD   D,E
      this.d = this.e;
      cycles = 5;
    }
    break;
  case 0x54:
    {
      // LD   D,H
      this.d = this.h;
      cycles = 5;
    }
    break;
  case 0x55:
    {
      // LD   D,L
      this.d = this.l;
      cycles = 5;
    }
    break;
  case 0x56:
    {
      // LD   D,(HL)
      this.d = this.rd(this.hl());
      cycles = 7;
    }
    break;
  case 0x57:
    {
      // LD   D,A
      this.d = this.a;
      cycles = 5;
    }
    break;
  case 0x58:
    {
      // LD   E,B
      this.e = this.b;
      cycles = 5;
    }
    break;
  case 0x59:
    {
      // LD   E,C
      this.e = this.c;
      cycles = 5;
    }
    break;
  case 0x5A:
    {
      // LD   E,D
      this.e = this.d;
      cycles = 5;
    }
    break;
  case 0x5B:
    {
      // LD   E,E
      this.e = this.e;
      cycles = 5;
    }
    break;
  case 0x5C:
    {
      // LD   E,H
      this.e = this.h;
      cycles = 5;
    }
    break;
  case 0x5D:
    {
      // LD   E,L
      this.e = this.l;
      cycles = 5;
    }
    break;
  case 0x5E:
    {
      // LD   E,(HL)
      this.e = this.rd(this.hl());
      cycles = 7;
    }
    break;
  case 0x5F:
    {
      // LD   E,A
      this.e = this.a;
      cycles = 5;
    }
    break;
  case 0x60:
    {
      // LD   H,B
      this.h = this.b;
      cycles = 5;
    }
    break;
  case 0x61:
    {
      // LD   H,C
      this.h = this.c;
      cycles = 5;
    }
    break;
  case 0x62:
    {
      // LD   H,D
      this.h = this.d;
      cycles = 5;
    }
    break;
  case 0x63:
    {
      // LD   H,E
      this.h = this.e;
      cycles = 5;
    }
    break;
  case 0x64:
    {
      // LD   H,H
      this.h = this.h;
      cycles = 5;
    }
    break;
  case 0x65:
    {
      // LD   H,L
      this.h = this.l;
      cycles = 5;
    }
    break;
  case 0x66:
    {
      // LD   H,(HL)
      this.h = this.rd(this.hl());
      cycles = 7;
    }
    break;
  case 0x67:
    {
      // LD   H,A
      this.h = this.a;
      cycles = 5;
    }
    break;
  case 0x68:
    {
      // LD   L,B
      this.l = this.b;
      cycles = 5;
    }
    break;
  case 0x69:
    {
      // LD   L,C
      this.l = this.c;
      cycles = 5;
    }
    break;
  case 0x6A:
    {
      // LD   L,D
      this.l = this.d;
      cycles = 5;
    }
    break;
  case 0x6B:
    {
      // LD   L,E
      this.l = this.e;
      cycles = 5;
    }
    break;
  case 0x6C:
    {
      // LD   L,H
      this.l = this.h;
      cycles = 5;
    }
    break;
  case 0x6D:
    {
      // LD   L,L
      this.l = this.l;
      cycles = 5;
    }
    break;
   case 0x6E:
    {
      // LD   L,(HL)
      this.l = this.rd(this.hl());
      cycles = 7;
    }
    break;
  case 0x6F:
    {
      // LD   L,A
      this.l = this.a;
      cycles = 5;
    }
    break;

  case 0x70:
    {
      // LD   (HL),B
      this.writeByte(this.hl(), this.b);
      cycles = 7;
    }
    break;
  case 0x71:
    {
      // LD   (HL),C
      this.writeByte(this.hl(), this.c);
      cycles = 7;
    }
    break;
  case 0x72:
    {
      // LD   (HL),D
      this.writeByte(this.hl(), this.d);
      cycles = 7;
    }
    break;
  case 0x73:
    {
      // LD   (HL),E
      this.writeByte(this.hl(), this.e);
      cycles = 7;
    }
    break;
  case 0x74:
    {
      // LD   (HL),H
      this.writeByte(this.hl(), this.h);
      cycles = 7;
    }
    break;
  case 0x75:
    {
      // LD   (HL),L
      this.writeByte(this.hl(), this.l);
      cycles = 7;
    }
    break;
  case 0x76:
    {
      // HALT
      this.halted = true;
      cycles = 7;
    }
    break;
  case 0x77:
    {
      // LD   (HL),A
      this.writeByte(this.hl(), this.a);
      cycles = 7;
    }
    break;
  case 0x78:
    {
      // LD   A,B
      this.a = this.b;
      cycles = 5;
    }
    break;
  case 0x79:
    {
      // LD   A,C
      this.a = this.c;
      cycles = 5;
    }
    break;
  case 0x7A:
    {
      // LD   A,D
      this.a = this.d;
      cycles = 5;
    }
    break;
  case 0x7B:
    {
      // LD   A,E
      this.a = this.e;
      cycles = 5;
    }
    break;
  case 0x7C:
    {
      // LD   A,H
      this.a = this.h;
      cycles = 5;
    }
    break;
  case 0x7D:
    {
      // LD   A,L
      this.a = this.l;
      cycles = 5;
    }
    break;
  case 0x7E:
    {
      // LD   A,(HL)
      this.a = this.rd(this.hl());
      cycles = 7;
    }
    break;
  case 0x7F:
    {
      // LD   A,A
      this.a = this.a;
      cycles = 5;
    }
    break;
  case 0x80:
    {
      // ADD  A,B
      this.a = this.addByte(this.a, this.b);
      cycles = 4;
    }
    break;
  case 0x81:
    {
      // ADD  A,C
      this.a = this.addByte(this.a, this.c);
      cycles = 4;
    }
    break;
  case 0x82:
    {
      // ADD  A,D
      this.a = this.addByte(this.a, this.d);
      cycles = 4;
    }
    break;
  case 0x83:
    {
      // ADD  A,E
      this.a = this.addByte(this.a, this.e);
      cycles = 4;
    }
    break;
  case 0x84:
    {
      // ADD  A,H
      this.a = this.addByte(this.a, this.h);
      cycles = 4;
    }
    break;
  case 0x85:
    {
      // ADD  A,L
      this.a = this.addByte(this.a, this.l);
      cycles = 4;
    }
    break;
  case 0x86:
    {
      // ADD  A,(HL)
      this.a = this.addByte(this.a, this.rd(this.hl()));
      cycles = 7;
    }
    break;
  case 0x87:
    {
      // ADD  A,A
      this.a = this.addByte(this.a, this.a);
      cycles = 4;
    }
    break;
  case 0x88:
    {
      // ADC  A,B
      this.a = this.addByteWithCarry(this.a, this.b);
      cycles = 4;
    }
    break;
    case 0x89:
      {
      // ADC  A,C
      this.a = this.addByteWithCarry(this.a, this.c);
      cycles = 4;
    }
    break;
  case 0x8A:
    {
      // ADC  A,D
      this.a = this.addByteWithCarry(this.a, this.d);
      cycles = 4;
    }
    break;
    case 0x8B:
      {
      // ADC  A,E
      this.a = this.addByteWithCarry(this.a, this.e);
      cycles = 4;
    }
    break;
  case 0x8C:
    {
      // ADC  A,H
      this.a = this.addByteWithCarry(this.a, this.h);
      cycles = 4;
    }
    break;
  case 0x8D:
    {
      // ADC  A,L
      this.a = this.addByteWithCarry(this.a, this.l);
      cycles = 4;
    }
    break;
  case 0x8E:
    {
      // ADC  A,(HL)
      this.a = this.addByteWithCarry(this.a, this.rd(this.hl()));
      cycles = 7;
    }
    break;
  case 0x8F:
    {
      // ADC  A,A
      this.a = this.addByteWithCarry(this.a, this.a);
      cycles = 4;
    }
    break;
  case 0x90:
    {
      // SUB  B
      this.a = this.subtractByte(this.a, this.b);
      cycles = 4;
    }
    break;
  case 0x91:
    {
      // SUB  C
      this.a = this.subtractByte(this.a, this.c);
      cycles = 4;
    }
    break;
  case 0x92:
    {
      // SUB  D
      this.a = this.subtractByte(this.a, this.d);
      cycles = 4;
    }
    break;
  case 0x93:
    {
      // SUB  E
      this.a = this.subtractByte(this.a, this.e);
      cycles = 4;
    }
    break;
  case 0x94:
    {
      // SUB  H
      this.a = this.subtractByte(this.a, this.h);
      cycles = 4;
    }
    break;
  case 0x95:
    {
      // SUB  L
      this.a = this.subtractByte(this.a, this.l);
      cycles = 4;
    }
    break;
  case 0x96:
    {
      // SUB  (HL)
      this.a = this.subtractByte(this.a, this.rd(this.hl()));
      cycles = 7;
    }
    break;
  case 0x97:
    {
      // SUB  A
      this.a = this.subtractByte(this.a, this.a);
      cycles = 4;
    }
    break;
  case 0x98:
    {
      // SBC  A,B
      this.a = this.subtractByteWithCarry(this.a, this.b);
      cycles = 4;
    }
    break;
  case 0x99:
    {
      // SBC  A,C
      this.a = this.subtractByteWithCarry(this.a, this.c);
      cycles = 4;
    }
    break;
  case 0x9A:
    {
      // SBC  A,D
      this.a = this.subtractByteWithCarry(this.a, this.d);
      cycles = 4;
    }
    break;
  case 0x9B:
    {
      // SBC  A,E
      this.a = this.subtractByteWithCarry(this.a, this.e);
      cycles = 4;
    }
    break;
  case 0x9C:
    {
      // SBC  A,H
      this.a = this.subtractByteWithCarry(this.a, this.h);
      cycles = 4;
    }
    break;
  case 0x9D:
    {
      // SBC  A,L
      this.a = this.subtractByteWithCarry(this.a, this.l);
      cycles = 4;
    }
    break;
  case 0x9E:
    {
      //  SBC  A,(HL)
      this.a = this.subtractByteWithCarry(this.a, this.rd(this.hl()));
      cycles = 7;
    }
    break;
  case 0x9F:
    {
      // SBC  A,A
      this.a = this.subtractByteWithCarry(this.a, this.a);
      cycles = 4;
    }
    break;
  case 0xA0:
    {
      // AND  B
      this.a = this.andByte(this.a, this.b);
      cycles = 4;
    }
    break;
  case 0xA1:
    {
      // AND  C
      this.a = this.andByte(this.a, this.c);
      cycles = 4;
    }
    break;
  case 0xA2:
    {
      // AND  D
      this.a = this.andByte(this.a, this.d);
      cycles = 4;
    }
    break;
  case 0xA3:
    {
      // AND  E
      this.a = this.andByte(this.a, this.e);
      cycles = 4;
    }
    break;
  case 0xA4:
    {
      // AND  H
      this.a = this.andByte(this.a, this.h);
      cycles = 4;
    }
    break;
  case 0xA5:
    {
      // AND  L
      this.a = this.andByte(this.a, this.l);
      cycles = 4;
    }
    break;
  case 0xA6:
    {
      // AND  (HL)
      this.a = this.andByte(this.a, this.rd(this.hl()));
      cycles = 7;
    }
    break;
  case 0xA7:
    {
      // AND  A
      this.a = this.andByte(this.a, this.a);
      cycles = 4;
    }
    break;
  case 0xA8:
    {
      // XOR  B
      this.a = this.xorByte(this.a, this.b);
      cycles = 4;
    }
    break;
  case 0xA9:
    {
      // XOR  C
      this.a = this.xorByte(this.a, this.c);
      cycles = 4;
    }
    break;
  case 0xAA:
    {
      // XOR  D
      this.a = this.xorByte(this.a, this.d);
      cycles = 4;
    }
    break;
  case 0xAB:
    {
      // XOR  E
      this.a = this.xorByte(this.a, this.e);
      cycles = 4;
    }
    break;
  case 0xAC:
    {
      // XOR  H
      this.a = this.xorByte(this.a, this.h);
      cycles = 4;
    }
    break;
  case 0xAD:
    {
      // XOR  L
      this.a = this.xorByte(this.a, this.l);
      cycles = 4;
    }
    break;
  case 0xAE:
    {
      // XOR  (HL)
      this.a = this.xorByte(this.a, this.rd(this.hl()));
      cycles = 7;
    }
    break;
  case 0xAF:
    {
      // XOR  A
      this.a = this.xorByte(this.a, this.a);
      cycles = 4;
    }
    break;
  case 0xB0:
    {
      // OR  B
      this.a = this.orByte(this.a, this.b);
      cycles = 4;
    }
    break;
  case 0xB1:
    {
      // OR  C
      this.a = this.orByte(this.a, this.c);
      cycles = 4;
    }
    break;
  case 0xB2:
    {
      // OR  D
      this.a = this.orByte(this.a, this.d);
      cycles = 4;
    }
    break;
  case 0xB3:
    {
      // OR  E
      this.a = this.orByte(this.a, this.e);
      cycles = 4;
    }
    break;
  case 0xB4:
    {
      // OR  H
      this.a = this.orByte(this.a, this.h);
      cycles = 4;
    }
    break;
  case 0xB5:
    {
      // OR  L
      this.a = this.orByte(this.a, this.l);
      cycles = 4;
    }
    break;
  case 0xB6:
    {
      //  OR   (HL)
      this.a = this.orByte(this.a, this.rd(this.hl()));
      cycles = 7;
    }
    break;
  case 0xB7:
    {
      // OR  A
      this.a = this.orByte(this.a, this.a);
      cycles = 4;
    }
    break;
  case 0xB8:
    {
      //  CP   B
      this.subtractByte(this.a, this.b);
      cycles = 4;
    }
    break;
  case 0xB9:
    {
      //  CP   C
      this.subtractByte(this.a, this.c);
      cycles = 4;
    }
    break;
  case 0xBA:
    {
      //  CP   D
      this.subtractByte(this.a, this.d);
      cycles = 4;
    }
    break;
  case 0xBB:
    {
      //  CP   E
      this.subtractByte(this.a, this.e);
      cycles = 4;
    }
    break;
  case 0xBC:
    {
      //  CP   H
      this.subtractByte(this.a, this.h);
      cycles = 4;
    }
    break;
  case 0xBD:
    {
      //  CP   L
      this.subtractByte(this.a, this.l);
      cycles = 4;
    }
    break;
  case 0xBE:
    {
      // CP   (HL)
      this.subtractByte(this.a, this.rd(this.hl()));
      cycles = 7;
    }
    break;
  case 0xBF:
    {
      //  CP   A
      this.subtractByte(this.a, this.a);
      cycles = 4;
    }
    break;
  case 0xC0:
    {
      //  RET  NZ      ; opcode C0 cycles 05
      if (this.f & Cpu.ZERO)
	cycles = 5;
      else {
	this.pc = this.pop();
	cycles = 11;
      }
    }
    break;
  case 0xC1:
    {
      //  POP  BC
      this.BC(this.pop());
      cycles = 10;
    }
    break;
  case 0xC2:
    {
      // JP   NZ,nn
      if (this.f & Cpu.ZERO) {
	this.pc = (this.pc + 2) & 0xFFFF;
      }
      else {
	this.pc = this.nextWord();
      }
      cycles = 10;
    }
    break;
  case 0xC3:
    {
      //  JP   nn
      this.pc = this.getWord(this.pc);
      cycles = 10;
    }
    break;
  case 0xC4:
    {
      //  CALL NZ,nn
      if (this.f & Cpu.ZERO) {
	this.pc = (this.pc + 2) & 0xFFFF;
	cycles = 11;
      }
      else {
	var w = this.nextWord();
	this.push(this.pc);
	this.pc = w;
	cycles = 17;
      }
    }
    break;
  case 0xC5:
    {
      //  PUSH BC
      this.push(this.bc());
      cycles = 11;
    }
    break;
  case 0xC6:
    {
      //  ADD  A,n
      this.a = this.addByte(this.a, this.nextByte());
      cycles = 7;
    }
    break;
  case 0xC7:
    {
      // RST  0
      this.push(this.pc);
      this.pc = 0;
      cycles = 11;
    }
    break;
  case 0xC8:
    {
      // RET Z
      if (this.f & Cpu.ZERO) {
	this.pc = this.pop();
	cycles = 11;
      }
      else {
	cycles = 5;
      }
    }
    break;
  case 0xC9:
    {
      // RET  nn
      this.pc = this.pop();
      cycles = 10;
    }
    break;
  case 0xCA:
    {
      // JP   Z,nn
      if (this.f & Cpu.ZERO) {
	this.pc = this.nextWord();
      }
      else {
	this.pc = (this.pc + 2) & 0xFFFF;
      }
      cycles = 10;
    }
    break;
  case 0xCC:
    {
      //  CALL Z,nn
      if (this.f & Cpu.ZERO) {
	var w = this.nextWord();
	this.push(this.pc);
	this.pc = w;
	cycles = 17;
      }
      else {
	this.pc = (this.pc + 2) & 0xFFFF;
	cycles = 11;
      }
    }
    break;
  case 0xCD:
    {
      // CALL nn
      var w = this.nextWord();
      this.push(this.pc);
      this.pc = w;
      cycles = 17;
    }
    break;
  case 0xCE:
    {
      // ADC  A,n
      this.a = this.addByteWithCarry(this.a, this.nextByte());
      cycles = 7;
    }
    break;
  case 0xCF:
    {
      // RST  8
      this.push(this.pc);
      this.pc = 0x08;
      cycles = 11;
    }
    break;
  case 0xD0:
    {
      // RET NC
      if (this.f & Cpu.CARRY) {
	cycles = 5;
      }
      else {
	this.pc = this.pop();
	cycles = 11;
      }
    }
    break;
  case 0xD1:
    {
      // POP DE
      this.DE(this.pop());
      cycles = 10;
    }
    break;
  case 0xD2:
    {
      // JP   NC,nn
      if (this.f & Cpu.CARRY) {
	this.pc = (this.pc + 2) & 0xFFFF;
      }
      else {
	this.pc = this.nextWord();
      }
      cycles = 10;
    }
    break;
  case 0xD3:
    {
      // OUT  (n),A
      this.writePort(this.nextByte(), this.a);
      cycles = 10;
    }
    break;
  case 0xD4:
    {
      //  CALL NC,nn
      if (this.f & Cpu.CARRY) {
	this.pc = (this.pc + 2) & 0xFFFF;
	cycles = 11;
      }
      else {
	var w = this.nextWord();
	this.push(this.pc);
	this.pc = w;
	cycles = 17;
      }
    }
    break;
  case 0xD5:
    {
      //  PUSH DE
      this.push(this.de());
      cycles = 11;
    }
    break;
  case 0xD6:
    {
      // SUB  n
      this.a = this.subtractByte(this.a, this.nextByte());
      cycles = 7;
    }
    break;
  case 0xD7:
    {
      // RST  10H
      this.push(this.pc);
      this.pc = 0x10;
      cycles = 11;
    }
    break;
  case 0xD8:
    {
      // RET C
      if (this.f & Cpu.CARRY) {
	this.pc = this.pop();
	cycles = 11;
      }
      else {
	cycles = 5;
      }
    }
    break;
  case 0xDA:
    {
      // JP   C,nn
      if (this.f & Cpu.CARRY) {
	this.pc = this.nextWord();
      }
      else {
	this.pc = (this.pc + 2) & 0xFFFF;
      }
      cycles = 10;
    }
    break;
  case 0xDB:
    {
      // IN   A,(n)
      this.a = this.readPort(this.nextByte());
      cycles = 10;
    }
    break;
  case 0xDC:
    {
      //  CALL C,nn
      if (this.f & Cpu.CARRY) {
	var w = this.nextWord();
	this.push(this.pc);
	this.pc = w;
	cycles = 17;
      }
      else {
	this.pc = (this.pc + 2) & 0xFFFF;
	cycles = 11;
      }
    }
    break;
  case 0xDE:
    {
      // SBC  A,n
      this.a = this.subtractByteWithCarry(this.a, this.nextByte());
      cycles = 7;
    }
    break;
  case 0xDF:
    {
      // RST  18H
      this.push(this.pc);
      this.pc = 0x18;
      cycles = 11;
    }
    break;
  case 0xE0:
    {
      // RET PO
      if (this.f & Cpu.PARITY) {
	cycles = 5;
      }
      else {
	this.pc = this.pop();
	cycles = 11;
      }
    }
    break;
  case 0xE1:
    {
      // POP HL
      this.HL(this.pop());
      cycles = 10;
    }
    break;
  case 0xE2:
    {
      // JP   PO,nn
      if (this.f & Cpu.PARITY) {
	this.pc = (this.pc + 2) & 0xFFFF;
      }
      else {
	this.pc = this.nextWord();
      }
      cycles = 10;
    }
    break;
  case 0xE3:
    {
      // EX   (SP),HL ;
      var a = this.getWord(this.sp);
      this.writeWord(this.sp, this.hl());
      this.HL(a);
      cycles = 4;
    }
    break;
  case 0xE4:
    {
      //  CALL PO,nn
      if (this.f & Cpu.PARITY) {
	this.pc = (this.pc + 2) & 0xFFFF;
	cycles = 11;
      }
      else {
	var w = this.nextWord();
	this.push(this.pc);
	this.pc = w;
	cycles = 17;
      }
    }
    break;
  case 0xE5:
    {
      //  PUSH HL
      this.push(this.hl());
      cycles = 11;
    }
    break;
  case 0xE6:
    {
      // AND  n
      this.a = this.andByte(this.a, this.nextByte());
      cycles = 7;
    }
    break;
  case 0xE7:
    {
      // RST  20H
      this.push(this.pc);
      this.pc = 0x20;
      cycles = 11;
    }
    break;
  case 0xE8:
    {
      // RET PE
      if (this.f & Cpu.PARITY) {
	this.pc = this.pop();
	cycles = 11;
      }
      else {
	cycles = 5;
      }
    }
    break;
  case 0xE9:
    {
      // JP   (HL)
      this.pc = this.hl();
      cycles = 4;
    }
    break;
  case 0xEA:
    {
      // JP   PE,nn
      if (this.f & Cpu.PARITY) {
	this.pc = this.nextWord();
      }
      else {
	this.pc = (this.pc + 2) & 0xFFFF;
      }
      cycles = 10;
    }
    break;
  case 0xEB:
    {
      // EX   DE,HL
      var a = this.de();
      this.DE(this.hl());
      this.HL(a);
      cycles = 4;
    }
    break;
  case 0xEC:
    {
      //  CALL PE,nn
      if (this.f & Cpu.PARITY) {
	var w = this.nextWord();
	this.push(this.pc);
	this.pc = w;
	cycles = 17;
      }
      else {
	this.pc = (this.pc + 2) & 0xFFFF;
	cycles = 11;
      }
    }
    break;
  case 0xEE:
    {
      // XOR  n
      this.a = this.xorByte(this.a, this.nextByte());
      cycles = 7;
    }
    break;
  case 0xEF:
    {
      // RST  28H
      this.push(this.pc);
      this.pc = 0x28;
      cycles = 11;
    }
    break;
  case 0xF0:
    {
      // RET P
      if (this.f & Cpu.SIGN) {
	cycles = 5;
      }
      else {
	this.pc = this.pop();
	cycles = 11;
      }
    }
    break;
  case 0xF1:
    {
      // POP AF
      this.AF(this.pop());
      cycles = 10;
    }
    break;
  case 0xF2:
    {
      // JP   P,nn
      if (this.f & Cpu.SIGN) {
	this.pc = (this.pc + 2) & 0xFFFF;
      }
      else {
	this.pc = this.nextWord();
      }
      cycles = 10;
    }
    break;
  case 0xF3:
    {
      // DI
      this.intenable = false;
      cycles = 4;
    }
    break;
  case 0xF4:
      {
      //  CALL P,nn
      if (this.f & Cpu.SIGN) {
	this.pc = (this.pc + 2) & 0xFFFF;
	cycles = 11;
      }
      else {
	var w = this.nextWord();
	this.push(this.pc);
	this.pc = w;
	cycles = 17;
      }
    }
    break;
  case 0xF5:
    {
      //  PUSH AF
      this.push(this.af());
      cycles = 11;
    }
    break;
  case 0xF6:
    {
      // OR   n
      this.a = this.orByte(this.a, this.nextByte());
      cycles = 7;
    }
    break;
  case 0xF7:
    {
      // RST  30H
      this.push(this.pc);
      this.pc = 0x30;
      cycles = 11;
    }
    break;
  case 0xF8:
    {
      // RET M
      if (this.f & Cpu.SIGN) {
	this.pc = this.pop();
	cycles = 11;
      }
      else {
	cycles = 5;
      }
    }
    break;
  case 0xF9:
    {
      // LD   SP,HL
      this.sp = this.hl();
      cycles = 6;
    }
    break;
  case 0xFA:
    {
      // JP   M,nn
      if (this.f & Cpu.SIGN) {
	this.pc = this.nextWord();
      }
      else {
	this.pc = (this.pc + 2) & 0xFFFF;
      }
      cycles = 10;
    }
    break;
  case 0xFB:
    {
      // EI
      this.intenable = true;
      cycles = 4;
    }
    break;
  case 0xFC:
    {
      //  CALL M,nn
      if (this.f & Cpu.SIGN) {
	var w = this.nextWord();
	this.push(this.pc);
	this.pc = w;
	cycles = 17;
      }
      else {
	this.pc = (this.pc + 2) & 0xFFFF;
	cycles = 11;
      }
    }
    break;
  case 0xFE:
    {
      // CP   n
      this.subtractByte(this.a, this.nextByte());
      cycles = 7;
    }
    break;
  case 0xFF:
    {
      // RST  38H
      this.push(this.pc);
      this.pc = 0x38;
      cycles = 11;
    }
    break;
  default:
    {
      // illegal
      this.halted = true;
      cycles = 4;
    }
    break;
  }

  return cycles;
};

// disassembler accesses RAM directly
//   just for the case of memory mapped IO, not to trigger IO!
// uses Intel mnemonics.
Cpu.prototype.disassembleInstructionIntel = (function () {

  var reg8List     = ['B', 'C', 'D', 'E', 'H', 'L', 'M', 'A'];
  var regpairList  = ['B', 'D', 'H', 'SP' ];
  var regpair2List = ['B', 'D', 'H', 'PSW' ];
  var ccList       = ['NZ', 'Z', 'NC', 'C', 'PO', 'PE', 'P', 'M'];

  function regs3(b)  { return reg8List[    (b     ) & 7]; }  // bits [2:0]
  function regd3(b)  { return reg8List[    (b >> 3) & 7]; }  // bits [5:3]
  function regr2(b)  { return regpairList[ (b >> 4) & 3]; }  // bits [5:4]
  function regr2b(b) { return regpair2List[(b >> 4) & 3]; }  // bits [5:4]
  function regr1(b)  { return regpairList[ (b >> 4) & 1]; }  // bit    [4]
  function cc(b)     { return ccList[      (b >> 3) & 7]; }  // bits [5:3]
  function rsti(b)   { return              (b >> 3) & 7 ; }  // bits [5:3]

  function hex8(v) {
    if (v < 8)
      return v.toString();
    var r = v.toString(16).toUpperCase() + 'H';
    return (r.charAt(0) < "A") ? r : ('0' + r); // hex literals can't start A-F
  }

  function hex16(b0, b1) {
    if (v < 8)
      return v.toString();
    var v = b0 + 256*b1;
    var r = v.toString(16).toUpperCase() + 'H';
    return (r.charAt(0) < "A") ? r : ('0' + r); // hex literals can't start A-F
  }

  // note that the order matters, since there are a few overlapping cases,
  // eg, HLT=0x76, which would be decoded as MOV M,M.  So we put the most
  // specific cases, as they are tucked into holes in the other parts of
  // the intruction decoding map.

  var intelTable = [
   // mask, value, length, dasm function
    [ 0xFF, 0x00, 1, function(i0,i1,i2) { return "NOP"; } ],
    [ 0xFF, 0x76, 1, function(i0,i1,i2) { return "HLT" } ],
    [ 0xFF, 0xEB, 1, function(i0,i1,i2) { return "XCHG"; } ],
    [ 0xFF, 0x07, 1, function(i0,i1,i2) { return "RLC"; } ],
    [ 0xFF, 0x0F, 1, function(i0,i1,i2) { return "RRC"; } ],
    [ 0xFF, 0x17, 1, function(i0,i1,i2) { return "RAL"; } ],
    [ 0xFF, 0x1F, 1, function(i0,i1,i2) { return "RAR"; } ],
    [ 0xFF, 0x2F, 1, function(i0,i1,i2) { return "CMA"; } ],
    [ 0xFF, 0x37, 1, function(i0,i1,i2) { return "STC"; } ],
    [ 0xFF, 0x3F, 1, function(i0,i1,i2) { return "CMC"; } ],
    [ 0xFF, 0x27, 1, function(i0,i1,i2) { return "DAA"; } ],
    [ 0xFF, 0xFB, 1, function(i0,i1,i2) { return "EI"; } ],
    [ 0xFF, 0xF3, 1, function(i0,i1,i2) { return "DI"; } ],
    [ 0xFF, 0xC9, 1, function(i0,i1,i2) { return "RET"; } ],
    [ 0xFF, 0xF9, 1, function(i0,i1,i2) { return "SPHL"; } ],
    [ 0xFF, 0xE3, 1, function(i0,i1,i2) { return "XTHL"; } ],
    [ 0xFF, 0xC6, 2, function(i0,i1,i2) { return "ADI " + hex8(i1); } ],
    [ 0xFF, 0xCE, 2, function(i0,i1,i2) { return "ACI " + hex8(i1); } ],
    [ 0xFF, 0xD6, 2, function(i0,i1,i2) { return "SUI " + hex8(i1); } ],
    [ 0xFF, 0xDE, 2, function(i0,i1,i2) { return "SBI " + hex8(i1); } ],
    [ 0xFF, 0xE6, 2, function(i0,i1,i2) { return "ANI " + hex8(i1); } ],
    [ 0xFF, 0xEE, 2, function(i0,i1,i2) { return "XRI " + hex8(i1); } ],
    [ 0xFF, 0xF6, 2, function(i0,i1,i2) { return "ORI " + hex8(i1); } ],
    [ 0xFF, 0xFE, 2, function(i0,i1,i2) { return "CPI " + hex8(i1); } ],
    [ 0xFF, 0xDB, 2, function(i0,i1,i2) { return "IN "  + hex8(i1); } ],
    [ 0xFF, 0xD3, 2, function(i0,i1,i2) { return "OUT " + hex8(i1); } ],
    [ 0xFF, 0x32, 3, function(i0,i1,i2) { return "STA " + hex16(i1,i2); } ],
    [ 0xFF, 0x3A, 3, function(i0,i1,i2) { return "LDA " + hex16(i1,i2); } ],
    [ 0xFF, 0x22, 3, function(i0,i1,i2) { return "SHLD " + hex16(i1,i2); } ],
    [ 0xFF, 0x2A, 3, function(i0,i1,i2) { return "LHLD " + hex16(i1,i2); } ],
    [ 0xFF, 0xC3, 3, function(i0,i1,i2) { return "JMP "  + hex16(i1,i2); } ],
    [ 0xFF, 0xCD, 3, function(i0,i1,i2) { return "CALL " + hex16(i1,i2); } ],
    [ 0xFF, 0xCD, 3, function(i0,i1,i2) { return "SHLD " + hex16(i1,i2); } ],

    [ 0xEF, 0x02, 1, function(i0,i1,i2) { return "STAX " + regr1(i0); } ],
    [ 0xEF, 0x0A, 1, function(i0,i1,i2) { return "LDAX " + regr1(i0); } ],

    [ 0xCF, 0x03, 1, function(i0,i1,i2) { return "INX "  + regd3(i0); } ],
    [ 0xCF, 0x0B, 1, function(i0,i1,i2) { return "DCX "  + regd3(i0); } ],
    [ 0xCF, 0xC5, 1, function(i0,i1,i2) { return "PUSH " + regr2b(i0); } ],
    [ 0xCF, 0xC1, 1, function(i0,i1,i2) { return "POP "  + regr2b(i0); } ],
    [ 0xCF, 0x09, 1, function(i0,i1,i2) { return "DAD "  + regr2(i0); } ],
    [ 0xCF, 0x01, 3, function(i0,i1,i2) { return "LXI "  + regr2(i0) + ',' + hex16(i1,i2); } ],

    [ 0xF8, 0x80, 1, function(i0,i1,i2) { return "ADD " + regs3(i0); } ],
    [ 0xF8, 0x88, 1, function(i0,i1,i2) { return "ADC " + regs3(i0); } ],
    [ 0xF8, 0x90, 1, function(i0,i1,i2) { return "SUB " + regs3(i0); } ],
    [ 0xF8, 0x98, 1, function(i0,i1,i2) { return "SBB " + regs3(i0); } ],
    [ 0xF8, 0xA0, 1, function(i0,i1,i2) { return "ANA " + regs3(i0); } ],
    [ 0xF8, 0xA8, 1, function(i0,i1,i2) { return "XRA " + regs3(i0); } ],
    [ 0xF8, 0xB0, 1, function(i0,i1,i2) { return "ORA " + regs3(i0); } ],
    [ 0xF8, 0xB8, 1, function(i0,i1,i2) { return "CMP " + regs3(i0); } ],

    [ 0xC7, 0x04, 1, function(i0,i1,i2) { return "INR " + regd3(i0); } ],
    [ 0xC7, 0x05, 1, function(i0,i1,i2) { return "DCR " + regd3(i0); } ],
    [ 0xC7, 0x06, 2, function(i0,i1,i2) { return "MVI " + regd3(i0) + ',' + hex8(i1); } ],
    [ 0xC7, 0xC0, 1, function(i0,i1,i2) { return "R" + cc(i0); } ],
    [ 0xC7, 0xC2, 3, function(i0,i1,i2) { return "J" + cc(i0) + ' ' + hex16(i1,i2); } ],
    [ 0xC7, 0xC4, 3, function(i0,i1,i2) { return "C" + cc(i0) + ' ' + hex16(i1,i2); } ],
    [ 0xC7, 0xC7, 1, function(i0,i1,i2) { return "RST " + rsti(i0); } ],

    [ 0xC0, 0x40, 1, function(i0,i1,i2) { return "MOV " + regd3(i0) + ',' + regs3(i0); } ],

    [ 0x00, 0x00, 1, function(i0,i1,i2) { return "ILLEGAL"; } ]  // catch-all
  ];

  // we could have the function scan the table for each op, but as a concession
  // to speed, we build a 256-entry table of pointers to the correct entry for a
  // given first instruction byte.
  var mappedtable = [];
  var matched;
  for(var inst=0; inst <= 0xFF; inst++) {
    matched = false;
    for(var n=0; !matched; n++) {  // guarantee: at least the last entry matches
      matched = ((inst & intelTable[n][0]) === intelTable[n][1]);
      if (matched) {
	mappedtable[inst] = intelTable[n];
      }
    }
  }

  return function (addr) {
    var b0 = this.ram[addr];
    var b1 = this.ram[addr+1];
    var b2 = this.ram[addr+2];
    var entry = mappedtable[b0];
    var len = entry[2];
    var r = entry[3](b0,b1,b2);
    return [addr+len, r];
  };

})();

// disassemble the instruction at the specified address,
// dressed with address and instruction byte info
Cpu.prototype.disassemble1 = function(addr) {
  var r = [];
  var d = this.disassembleInstructionIntel(addr);
  r.push(pad(addr.toString(16), 4));
  r.push(": ");
  for(var j = 0; j < d[0]-addr; j++)
    r.push(pad(this.ram[addr+j].toString(16), 2));
  while(j++ < 3)
    r.push("  ");
  r.push(" ");
  r.push(d[1]);
  return [d[0], r.join("")];
};

// disassemble 16 instructions, starting at the specified address
Cpu.prototype.disassemble = function(addr) {
  var r = [];
  for(var i=0; i < 16; ++i) {
    var l = this.disassemble1(addr);
    r.push(l[1]);
    r.push("\r\n");
    addr = l[0];
  }
  return [r.join(""), addr];
};

// vim:sw=2:
