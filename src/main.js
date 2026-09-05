const { InstanceBase, InstanceStatus, Regex } = require('@companion-module/base')
const UpgradeScripts = require('./upgrades')
const ActionMethods = require('./actions')
const FeedbackMethods = require('./feedbacks')
const VariableMethods = require('./variables')
const PresetMethods = require('./presets')
const ConnectionMethods = require('./connection')

// https://lightware.com/pub/media/lightware/filedownloader/file/Lightware_s_Open_API_Environment_v1.pdf
// https://lightware.com/pub/media/lightware/filedownloader/file/User-Manual/MX2-8x8-HDMI20_series_Users_Manual_v2.4.pdf

class ModuleInstance extends InstanceBase {
	PSTATE_READY = 0
	PSTATE_MULTILINE = 1

	actions = {}
	variables = {}
	presets = {}
	state = { destinationConnectionList: [], selectedSource: '', selectedDestination: '' }

	// Set once the device has told us which paths its firmware uses
	xpPath = undefined
	presetStyle = undefined

	inputs = {}
	outputs = {}
	CHOICES_INPUTS = []
	CHOICES_OUTPUTS = []
	CHOICES_PRESETS = []

	constructor(internal) {
		super(internal)
		this.instanceOptions.disableVariableValidation = true
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value:
					'This module is for controlling Lightware equipment that supports the LW3 protocol. The device is queried for the paths it supports, so it should work across firmware generations. Please open an issue if your LW3 compatible equipment is not supported.',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Device IP',
				width: 12,
				regex: Regex.IP,
			},
			{
				type: 'checkbox',
				id: 'verbose',
				label: 'Log protocol traffic',
				tooltip: 'Writes every command sent to and received from the device to the log. For troubleshooting only.',
				width: 12,
				default: false,
			},
		]
	}

	async init(config) {
		this.config = config
		this.updateStatus(InstanceStatus.Connecting)
		// Actions are registered before connecting so they stay browsable while the
		// device is offline; the port dropdowns are refilled once it reports its ports.
		this.initActions()
		this.initVariables()
		this.initFeedbacks()
		this.initPresets()
		this.initTCP()
	}

	async destroy() {
		if (this.socket !== undefined) {
			this.socket.destroy()
			delete this.socket
		}
	}

	async configUpdated(config) {
		const resetConnection = this.config?.host !== config.host

		this.config = config

		if (resetConnection || this.socket === undefined) {
			this.initTCP()
		}
	}
}

Object.assign(
	ModuleInstance.prototype,
	ActionMethods,
	FeedbackMethods,
	VariableMethods,
	PresetMethods,
	ConnectionMethods,
)

module.exports = ModuleInstance
module.exports.UpgradeScripts = UpgradeScripts
