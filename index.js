var tcp = require('../../tcp');
var instance_skel = require('../../instance_skel');
var debug;
var log;

// https://lightware.com/pub/media/lightware/filedownloader/file/Lightware_s_Open_API_Environment_v1.pdf
// https://lightware.com/pub/media/lightware/filedownloader/file/User-Manual/MX2-8x8-HDMI20_series_Users_Manual_v2.4.pdf

var DTYPE_UNKNOWN = 0;
var DTYPE_GENERAL = 'GENERAL';
var DTYPE_MX2 = 'MX2';

function instance(system, id, config) {
	var self = this;

	self.deviceType = DTYPE_UNKNOWN;
	self.inputs = {};
	self.outputs = {};

	self.CHOICES_INPUTS = [];
	self.CHOICES_OUTPUTS = [];

	// super-constructor
	instance_skel.apply(this, arguments);

	self.actions(); // export actions

	return self;
}

instance.prototype.updateConfig = function(config) {
	var self = this;

	self.config = config;
	self.init_tcp();
};

instance.prototype.init = function() {
	var self = this;

	debug = self.debug;
	log = self.log;

	self.status(self.STATE_UNKNOWN);

	self.init_tcp();
};

var PSTATE_READY = 0,
		PSTATE_MULTILINE = 1,
		PSTATE_SINGLELINE = 2;

instance.prototype.init_tcp = function() {
	var self = this;
	var receivebuffer = '';
	self.pstate = PSTATE_READY;
	self.pid = '';
	self.multiline = '';
	self.multilineError = '';
	self.responseHandlers = {};
	self.sendId = 0;

	if (self.socket !== undefined) {
		self.socket.destroy();
		delete self.socket;
	}

	if (self.config.host) {
		self.socket = new tcp(self.config.host, 6107);

		self.socket.on('status_change', function (status, message) {
			self.status(status, message);
		});

		self.socket.on('connect', function () {
			self.initDevice();
		});

		self.socket.on('error', function (err) {
			debug("Network error", err);
			self.log('error',"Network error: " + err.message);
		});

		self.socket.on('data', function (chunk) {
			var i = 0, line = '', offset = 0;
			receivebuffer += chunk;

			while ( (i = receivebuffer.indexOf('\r\n', offset)) !== -1) {
				line = receivebuffer.substr(offset, i - offset);
				offset = i + 2;
				self.socket.emit('receiveline', line.toString());
			}
			receivebuffer = receivebuffer.substr(offset);
		});

		self.socket.on('receiveline', function (line) {
			if (self.pstate == PSTATE_READY) {
				if (line.substr(0, 1) == '{') {
					self.pstate = PSTATE_MULTILINE;
					self.multiline = '';
					self.multilineError = '';
					self.pid = line.substr(1);
				}
			}
			else if (self.pstate == PSTATE_MULTILINE) {
				if (line == '}') {
					if (self.responseHandlers[self.pid] !== undefined) {
						if (self.multilineError.trim() != '') {
							log('error', 'Error from device: ' + self.multilineError);
						}

						self.responseHandlers[self.pid](self.multiline.trim());
						delete self.responseHandlers[self.pid];
					}

					self.pstate = PSTATE_READY;
				} else {
					if (line.substr(1,1) == 'E') {
						self.multilineError += line.substr(3) + "\r\n";
					} else {
						self.multiline += line.substr(3) + "\r\n";
					}
				}
			}
		});
	}
};

instance.prototype.sendCommand = function(command, cb) {
	var self = this;
	var id = ('0000' + self.sendId++).substr(-4);

	if (self.socket !== undefined && self.socket.connected) {
		self.socket.send(id + '#' + command + "\r\n");
		self.responseHandlers[id] = cb;
	} else {
		debug('Socket not connected :(');
	}
};

instance.prototype.initDevice = function() {
	var self = this;

	self.sendCommand('GET /.ProductName', function (result) {
		result = result.replace(/\/\.ProductName=/,'');

		log('info', 'Connected to an ' + result);

		if (result.match(/OPTC-[TR]X|MMX6x2|MMX4x2|UMX-TPS-[TR]X100/) ||
			result.match(/(^MEX-)|HDMI-TPS-[TR]X200|HDMI-3D-OPT|SW4-OPT|MODEX/)) {
			self.deviceType = DTYPE_GENERAL;
			self.initGENERAL();
		}
		else if (result.match(/^MX2/)) {
			self.deviceType = DTYPE_MX2;
			self.initMX2();
		} else {
			log('warning', 'Unknown LW3 device, use with caution');
			self.deviceType = DTYPE_GENERAL;
			self.initMX2();
		}
	});
};

instance.prototype.initGENERAL = function() {
	var self = this;

	self.sendCommand('GET /MEDIA/VIDEO/*.Text', function (result) {
		var list = result.split(/\r\n/);

		self.CHOICES_INPUTS.length = 0;
		self.CHOICES_OUTPUTS.length = 0;

		for (var i in list) {
			var match = list[i].match(/\/MEDIA\/VIDEO\/(.+?)\.Text=(.+)$/);
			if (match) {
				var port = match[1];
				var name = match[2];

				if (port.match(/I\d+/)) {
					self.inputs[port] = name;
					self.CHOICES_INPUTS.push({ label: name, id: port });
				}
				if (port.match(/O\d+/)) {
					self.outputs[port] = name;
					self.CHOICES_OUTPUTS.push({ label: name, id: port });
				}
			}
		}
	});
};

instance.prototype.initMX2 = function() {
	var self = this;

	self.sendCommand('GET /MEDIA/NAMES/VIDEO.*', function (result) {
		var list = result.split(/\r\n/);

		self.CHOICES_INPUTS.length = 0;
		self.CHOICES_OUTPUTS.length = 0;

		for (var i in list) {
			var match = list[i].match(/\/MEDIA\/NAMES\/VIDEO\.(.+?)=\d+;(.+)$/);
			if (match) {
				var port = match[1];
				var name = match[2];

				if (port.match(/I\d+/)) {
					self.inputs[port] = name;
					self.CHOICES_INPUTS.push({ label: name, id: port });
				}
				if (port.match(/O\d+/)) {
					self.outputs[port] = name;
					self.CHOICES_OUTPUTS.push({ label: name, id: port });
				}
			}
		}
	});
};

// Return config fields for web config
instance.prototype.config_fields = function () {
	var self = this;
	return [
		{
			type: 'text',
			id: 'info',
			width: 12,
			label: 'Information',
			value: 'This module is for controlling Lightware equipment that supports LW3 protocol. So far only HDMI20_OPTC and MX2-8x8-HDMI20 have been tested. Please contact us if your LW3 compatible equipment is not supported'
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'Device IP',
			width: 12,
			regex: self.REGEX_IP
		}
	]
};

// When module gets deleted
instance.prototype.destroy = function() {
	var self = this;

	if (self.socket !== undefined) {
		self.socket.destroy();
	}

	debug("destroy", self.id);
};


instance.prototype.actions = function(system) {
	var self = this;

	self.system.emit('instance_actions', self.id, {
		'xpt': {
			label: 'XP:Switch - Select video input for output',
			options: [
				{
					label: 'Input',
					type: 'dropdown',
					id: 'input',
					choices: self.CHOICES_INPUTS
				},
				{
					label: 'Output',
					type: 'dropdown',
					id: 'output',
					choices: self.CHOICES_OUTPUTS
				}
			]
		}
	});
}

instance.prototype.GENERAL_XPT = function(opt) {
	var self = this;

	self.sendCommand('CALL /MEDIA/VIDEO/XP:switch(' + opt.input + ':' + opt.output + ')', function (result) {
		log('info', 'XPT Result: ' + result);
	});
};

instance.prototype.MX2_XPT = function(opt) {
	var self = this;

	self.sendCommand('CALL /MEDIA/XP/VIDEO:switch(' + opt.input + ':' + opt.output + ')', function (result) {
		log('info', 'XPT Result: ' + result);
	});
};


instance.prototype.action = function(action) {
	var self = this;
	var cmd;
	var opt = action.options;

	switch (action.action) {

		case 'xpt':
			self[self.deviceType + '_XPT'](opt);
			break;

	}
	debug('action():', action);

};

instance_skel.extendedBy(instance);
exports = module.exports = instance;
