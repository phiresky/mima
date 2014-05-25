var MimaCommand = (function () {
    function MimaCommand(name, func) {
        this.name = name;
        this.func = func;
    }
    MimaCommand.parseCmd = function (command, value) {
        var cmd = MimaCommand.commandsRev[command];
        if (cmd === undefined)
            return null;
        if (cmd >= 0xf)
            cmd = (cmd << 16) | (value & 0xffff);
        else
            cmd = (cmd << 20) | (value & 0xfffff);
        return cmd;
    };
    MimaCommand.commands = [
        new MimaCommand("LDC", function (m, v) {
            return m.akku = v;
        }),
        new MimaCommand("LDV", function (m, v) {
            return m.akku = m.mem[v];
        }),
        new MimaCommand("STV", function (m, v) {
            return m.mem[v] = m.akku;
        }),
        new MimaCommand("ADD", function (m, v) {
            return m.akku += m.mem[v];
        }),
        new MimaCommand("AND", function (m, v) {
            return m.akku &= m.mem[v];
        }),
        new MimaCommand("OR", function (m, v) {
            return m.akku |= m.mem[v];
        }),
        new MimaCommand("XOR", function (m, v) {
            return m.akku ^= m.mem[v];
        }),
        new MimaCommand("EQL", function (m, v) {
            return m.akku = m.akku === m.mem[v] ? -1 : 0;
        }),
        new MimaCommand("JMP", function (m, v) {
            return m.pointer = v;
        }),
        new MimaCommand("JMN", function (m, v) {
            return m.pointer = m.akku < 0 ? v : m.pointer;
        }),
        new MimaCommand("LDIV", function (m, v) {
            return m.akku = m.mem[m.mem[v]];
        }),
        new MimaCommand("STIV", function (m, v) {
            return m.mem[m.mem[v]] = m.akku;
        })
    ];
    MimaCommand.fCommands = [
        new MimaCommand("HLT", function (m, v) {
            m.running = false;
            m.pointer--;
        }),
        new MimaCommand("NOT", function (m, v) {
            return m.akku = ~m.akku;
        }),
        new MimaCommand("RAR", function (m, v) {
            return m.akku = ((m.akku >>> 1) | (m.akku << (23))) & (0xFFFFFF);
        })
    ];
    MimaCommand.commandsRev = {};
    return MimaCommand;
})();

var Mima = (function () {
    function Mima(data) {
        this.pointer = 0;
        this.akku = 0;
        this.running = false;
        this.stepNum = 0;
        this.mem = data.mem;
        this.srcMap = data.srcMap;
        this.pointer = data.start;
        this.finishCallback = data.finishCallback;
        this.stepCallback = data.stepCallback;
        this.logCallback = data.logCallback;
    }
    Mima.prototype.run = function (delay) {
        this.running = true;
        var m = this;
        function tryStep() {
            try  {
                m.step();
            } catch (e) {
                console.log(e.stack);
                m.logCallback(e.stack || e);
            }
        }
        this.intervalID = setInterval(tryStep, delay);
    };

    Mima.prototype.stop = function () {
        clearInterval(this.intervalID);
        this.running = false;
        this.logCallback("Mima halted after " + this.stepNum + " Steps at address " + this.pointer);
        this.finishCallback();
    };

    Mima.prototype.step = function (single) {
        this.stepNum++;
        if (this.stepNum >= Mima.MAX_RUNTIME) {
            this.stop();
            throw "Max Runtime reached";
            return;
        }
        var cmd = this.mem[this.pointer++];
        var op1 = (cmd >> 20) & 0xF;
        var cmdout;
        if (op1 == 0xF) {
            var op2 = (cmd >> 16) & 0xF;
            if (!MimaCommand.fCommands[op2])
                throw "invalid command: F" + op2;
            MimaCommand.fCommands[op2].func(this, cmd & 0xFFFF);
            cmdout = MimaCommand.fCommands[op2].name + " " + (cmd & 0xFFFF);
        } else {
            if (!MimaCommand.commands[op1])
                throw "invalid command: " + op1;
            MimaCommand.commands[op1].func(this, cmd & 0xFFFFF);
            cmdout = MimaCommand.commands[op1].name + " " + (cmd & 0xFFFFF);
        }
        this.logCallback("Step " + this.stepNum + " at " + this.pointer + ":  " + cmdout + " => " + this.akku);
        if (this.srcMap[this.pointer - 1] === undefined)
            console.log("no mapping for mem " + (this.pointer - 1) + " (" + cmdout + ")");
        this.stepCallback({ pointer: this.pointer - 1, line: this.srcMap[this.pointer - 1] || 0, akku: this.akku, cmd: cmdout });
        if (!single && !this.running)
            this.stop();
    };
    Mima.MAX_RUNTIME = 20000;
    return Mima;
})();
for (var i = 0; i < MimaCommand.commands.length; i++) {
    MimaCommand.commandsRev[MimaCommand.commands[i].name] = i;
}
for (var i = 0; i < MimaCommand.fCommands.length; i++) {
    MimaCommand.commandsRev[MimaCommand.fCommands[i].name] = i + 0xF0;
}

function toHex(i, length) {
    if (i < 0)
        i = ((~(-i)) & ((1 << 4 * length) - 1)) + 1;
    var str = i.toString(16).toUpperCase();
    while (str.length < length)
        str = '0' + str;
    return "0x" + str;
}

String.prototype.splitrim = function (sep) {
    var output = this.split(sep);
    for (var i = 0; i < output.length; i++)
        output[i] = output[i].trim();
    return output;
};

function parse(input) {
    var constants = {};
    var toParse = [];
    var inputSplit = input.splitrim("\n");
    var srcMap = {};
    var pointer = 0;
    var maxptr = 0;
    var markers = [];
    var mem = [];
    for (var l = 0; l < inputSplit.length; l++) {
        if (pointer > maxptr)
            maxptr = pointer;
        var line = inputSplit[l];
        var comment = line.splitrim(";");
        if (comment.length > 1)
            line = comment[0];
        if (line.length === 0)
            continue;
        var equals = line.splitrim("=");
        if (equals.length > 1) {
            if (equals[0] === "*")
                pointer = parseInt(equals[1]);
            else
                constants[equals[0]] = parseInt(equals[1]) & 0xfffff;
        } else {
            var label = line.splitrim(":");
            if (label.length > 1) {
                constants[label[0]] = pointer;
                line = label[1];
            }
            var lineSplit = line.splitrim(/\s+/);
            if (lineSplit[1] && lineSplit[1].toUpperCase() === "DS") {
                constants[lineSplit[0]] = pointer;
                var i = parseInt(lineSplit[2]) || 0;
                srcMap[pointer] = l;
                mem[pointer++] = i; //i&0xffffff;

                continue;
            } else if (lineSplit.length === 2) {
                var asInt = parseInt(lineSplit[1]);
                if (isNaN(asInt)) {
                    asInt = constants[lineSplit[1]];
                    if (asInt === undefined)
                        toParse.push({ l: l, line: lineSplit, pointer: pointer });
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
    toParse.forEach(function (p) {
        var asInt = constants[p.line[1]];
        if (asInt === undefined) {
            markers.push({ index: l, message: "unresolable constant " + p.line[1] });
            return;
        }
        mem[p.pointer] = MimaCommand.parseCmd(p.line[0], asInt);
    });
    for (var i = 0; i < maxptr; i++)
        mem[i] = mem[i] || 0;
    if (constants["START"] === undefined)
        markers.push({ index: 0, message: "could not find START label" });
    return { mem: mem, start: constants["START"], srcMap: srcMap, markers: markers };
}
