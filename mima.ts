// Mima compiler and interpreter written in TypeScript
// https://github.com/phiresky/mima

class MimaCommand {
	constructor(public name: string, public func: (mima: Mima, input: number) => void) { }

	public static commands = [
		new MimaCommand("LDC", (m, v) => m.akku = v),
		new MimaCommand("LDV", (m, v) => m.akku = m.mem[v]),
		new MimaCommand("STV", (m, v) => m.mem[v] = m.akku),
		new MimaCommand("ADD", (m, v) => m.akku += m.mem[v]),
		new MimaCommand("AND", (m, v) => m.akku &= m.mem[v]),
		new MimaCommand("OR", (m, v) => m.akku |= m.mem[v]),
		new MimaCommand("XOR", (m, v) => m.akku ^= m.mem[v]),
		new MimaCommand("EQL", (m, v) => m.akku = m.akku === m.mem[v] ? -1 : 0),
		new MimaCommand("JMP", (m, v) => m.pointer = v),
		new MimaCommand("JMN", (m, v) => m.pointer = m.akku < 0 ? v : m.pointer),
		new MimaCommand("LDIV", (m, v) => m.akku = m.mem[m.mem[v]]),
		new MimaCommand("STIV", (m, v) => m.mem[m.mem[v]] = m.akku),
		new MimaCommand("OUTPUT", (m, v) => {m.logCallback("OUTPUT: "+m.mem[v])}),
	];
	public static fCommands = [
		new MimaCommand("HLT", (m, v) => { m.running = false; m.pointer--; }),
		new MimaCommand("NOT", (m, v) => m.akku = ~m.akku),
		new MimaCommand("RAR", (m, v) => m.akku = ((m.akku >>> 1) | (m.akku << (23))) & (0xFFFFFF)),
	];
	public static commandsRev: { [name: string]: number } = {};

	static parseCmd(command: string, value: number): number {
		if(command=='DS') return value;
		if(command=='HALT') return MimaCommand.parseCmd('HLT',value);
		var cmd = MimaCommand.commandsRev[command];
		if (cmd === undefined) return null;
		if (cmd >= 0xf) cmd = (cmd << 16) | (value & 0xffff);
		else cmd = (cmd << 20) | (value & 0xfffff);
		return cmd;
	}

	static parseConst(value: string): number {
		if(!value) return 0;
		value = value.replace(/\$/,'0x');
		return parseInt(value) || 0;
	}
}

class Mima {
	pointer: number = 0;
	akku: number = 0;
	running: boolean = false;
	intervalID: number;
	stepNum: number = 0;
	finishCallback; stepCallback; logCallback;
	mem: number[];
	srcMap;
	public static MAX_RUNTIME = 10000;
	constructor(data: { start: number; mem: number[]; srcMap; finishCallback: () => void; stepCallback: () => void; logCallback: (message: string, pos?: number) => void }) {
		this.mem = data.mem;
		this.srcMap = data.srcMap;
		this.pointer = data.start;
		this.finishCallback = data.finishCallback;
		this.stepCallback = data.stepCallback;
		this.logCallback = data.logCallback;
	}

	public run(async: boolean, delay?: number) {
		this.running = true;
		var m = this;
		function tryStep() {
			try {
				m.step();
			} catch (e) { m.logCallback(e.stack || e); }
		}
		if (!async) {
			while (this.running) this.step(false, true);
			return;
		}
		this.intervalID = setInterval(tryStep, delay || 0);
	}

	public stop() {
		clearInterval(this.intervalID);
		this.running = false;
		this.logCallback("Mima halted after " + this.stepNum + " Steps at address " + this.pointer);
		this.finishCallback();
	}

	public step(single?: boolean, silent?: boolean): string {
		this.stepNum++;
		if (this.stepNum >= Mima.MAX_RUNTIME) { this.stop(); this.logCallback("Max Runtime reached, aborting."); return; }
		var cmd = this.mem[this.pointer++];
		if (cmd === undefined) { this.stop(); this.logCallback("reached undefined memory, aborting."); return; }
		var op1 = (cmd >> 20) & 0xF;
		var cmdout;
		if (op1 == 0xF) {
			var op2 = (cmd >> 16) & 0xF;
			if (!MimaCommand.fCommands[op2]) throw "invalid command: F" + op2;
			MimaCommand.fCommands[op2].func(this, cmd & 0xFFFF);
			cmdout = MimaCommand.fCommands[op2].name + " " + (cmd & 0xFFFF);
		} else {
			if (!MimaCommand.commands[op1]) throw "invalid command: " + op1;
			MimaCommand.commands[op1].func(this, cmd & 0xFFFFF);
			cmdout = MimaCommand.commands[op1].name + " " + (cmd & 0xFFFFF);
		}
		this.logCallback("Step " + this.stepNum + " at " + this.pointer + ":  " + cmdout + " => " + this.akku, silent);
		//if (this.srcMap[this.pointer - 1] === undefined) console.log("no mapping for mem " + (this.pointer - 1) + " (" + cmdout + ")");
		if (!silent && (cmd != 0 || this.mem[this.pointer - 2] != 0)) this.stepCallback({ pointer: this.pointer - 1, line: this.srcMap[this.pointer - 1] || 0, akku: this.akku, cmd: cmdout });
		if (!single && !this.running) this.stop();
	}
}
for (var i = 0; i < MimaCommand.commands.length; i++) {
	MimaCommand.commandsRev[MimaCommand.commands[i].name] = i;
}
for (var i = 0; i < MimaCommand.fCommands.length; i++) {
	MimaCommand.commandsRev[MimaCommand.fCommands[i].name] = i + 0xF0;
}

function toHex(i, length) {
	if (i < 0) i = ((~(-i)) & ((1 << 4 * length) - 1)) + 1;
	var str = i.toString(16).toUpperCase();
	while (str.length < length) str = '0' + str;
	return "0x" + str;
}

interface String { splitrim: (sep: any) => string[] }
String.prototype.splitrim = function(sep: any): string[] {
	var output = this.split(sep);
	for (var i = 0; i < output.length; i++) output[i] = output[i].trim();
	return output;
}


function parse(input: string): { mem: number[]; start: number; srcMap: { [memIndex: number]: number }; markers: { index: number; message: string }[] } {
	var constants: { [constant: string]: number } = {};
	var toParse: { line: string[]; pointer: number; l: number }[] = [];
	var inputSplit = input.splitrim("\n");
	var srcMap: { [memIndex: number]: number } = {};
	var pointer = 0;
	var maxptr = 0;
	var markers = [];
	var mem: number[] = [];
	for (var l = 0; l < inputSplit.length; l++) {
		if (pointer > maxptr) maxptr = pointer;
		var line = inputSplit[l];
		var comment = line.splitrim(";");
		if (comment.length > 1) line = comment[0];
		if (line.length === 0) continue;
		var equals = line.splitrim("=");
		if (equals.length > 1) { // Constant or movement
			if (equals[0] === "*") // movement
				pointer = MimaCommand.parseConst(equals[1]);
			else // constant
				constants[equals[0]] = MimaCommand.parseConst(equals[1]) & 0xfffff;
		} else { // datastore or statement
			var label = line.splitrim(":");
			if (label.length > 1) {
				constants[label[0]] = pointer;
				line = label[1];
			}
			var lineSplit = line.splitrim(/\s+/);
			if (lineSplit[1] && lineSplit[1].toUpperCase() === "DS") {
				constants[lineSplit[0]] = pointer;
				srcMap[pointer] = l;
				mem[pointer++] = MimaCommand.parseConst(lineSplit[2]);//i&0xffffff;
				continue;
			} else if (lineSplit.length === 2) {
				var asInt = parseInt(lineSplit[1]);
				if (isNaN(asInt)) {
					asInt = constants[lineSplit[1]];
					if (asInt === undefined) toParse.push({ l: l, line: lineSplit, pointer: pointer });
				}
			} else if (lineSplit.length === 1) {
				asInt = 0;
			} else if (lineSplit.length > 3) {
				markers.push({ index: l, message: "invalid line" });
			}
			srcMap[pointer] = l;
			var parsed = MimaCommand.parseCmd(lineSplit[0], asInt);
			if (parsed === null) {
				markers.push({ index: l, message: "unknown command " + lineSplit });
			} else
				mem[pointer++] = parsed;
		}
	}
	toParse.forEach((p) => {
		var asInt = constants[p.line[1]];
		if (asInt === undefined) {
			markers.push({ index: p.l, message: "unresolable constant " + p.line[1] });
			return;
		}
		mem[p.pointer] = MimaCommand.parseCmd(p.line[0], asInt);
	});
	for (var i = 0; i < maxptr; i++) mem[i] = mem[i] || 0;
	if (constants["START"] === undefined) markers.push({ index: 0, message: "could not find START label" });
	return { mem: mem, start: constants["START"], srcMap: srcMap, markers: markers };
}

function parseToC(input: string): string {
	var cMap = {
		"LDC": "akku = $;",
		"LDV": "akku = mem[$];",
		"STV": "mem[$] = akku;",
		"ADD": "akku += mem[$];",
		"AND": "akku &= mem[$];",
		"OR": "akku |= mem[$];",
		"XOR": "akku ^= mem[$];",
		"EQL": "akku = akku == mem[$] ? -1 : 0;",
		"JMP": "goto $;",
		"JMN": "if(akku<0) goto $;",
		"LDIV": "akku = mem[mem[$]];",
		"STIV": "mem[mem[$]] = akku;",
		"HLT": "return 0;",
		"NOT": "akku = ~akku;",
		"RAR": "akku = ((akku >> 1) | (akku << (23))) & (0xFFFFFF));",
		// unofficial commands
		"OUTPUT": 'printf("<$> = %d\\n",mem[$]);',
	}
	var constants: string[] = [];
	var inputSplit = input.splitrim("\n");
	var pointer = 0;
	var maxptr = 0;
	var commands: string[] = [];
	var alreadyDefined=[];
	for (var l = 0; l < inputSplit.length; l++) {
		if (pointer > maxptr) maxptr = pointer;
		var line = inputSplit[l];
		var comment = line.splitrim(";");
		if (comment.length > 1) line = comment[0];
		if (line.length === 0) continue;
		var equals = line.splitrim("=");
		if (equals.length > 1) { // Constant or movement
			if (equals[0] === "*") // movement
				pointer = parseInt(equals[1]);
			else // constant
				constants.push("int "+equals[0]+" = "+(parseInt(equals[1]) & 0xfffff)+";");
		} else { // datastore or statement
			var label = line.splitrim(":");
			var labelStr = "";
			if (label.length > 1) {
				labelStr="\n"+label[0]+":\n\t";
				line = label[1];
			}
			var lineSplit = line.splitrim(/\s+/);
			if (lineSplit[1] && lineSplit[1].toUpperCase() === "DS") {
				if(alreadyDefined.indexOf(lineSplit[0])>=0) {
					commands.push(labelStr+"mem["+pointer+"] = "+(lineSplit[2]||0)+";");
				} else {
					constants.push("int "+lineSplit[0]+" = "+pointer+";");
					alreadyDefined.push(lineSplit[0]);
					commands.push(labelStr+"mem["+lineSplit[0]+"] = "+(lineSplit[2]||0)+";");
				}
				pointer++;
				continue;
			} else if (lineSplit.length === 2) {
				var val = lineSplit[1];
			} else if (lineSplit.length === 1) {
				val = ""+0;
			}
			commands.push(labelStr+cMap[lineSplit[0]].replace(/\$/g,val));
		}
	}
	return "#include <stdio.h>\nint akku=0;\nint mem["+(maxptr+1)+"];\n\nint main() {\n\t"+constants.join("\n\t")+"\n\n\t"+commands.join("\n\t")+"\n}\n";
}

