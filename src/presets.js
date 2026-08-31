const { combineRgb } = require('@companion-module/base')

const SECTIONS = [
	{ id: 'select-input', name: 'Select Input' },
	{ id: 'select-output', name: 'Select Output' },
	{ id: 'select-input-and-take', name: 'Select Input and Take' },
	{ id: 'recall-preset', name: 'Recall Preset' },
	{ id: 'misc', name: 'Misc' },
]

module.exports = {
	createSelectPreset(port) {
		const pdat = {
			port,
			num: parseInt(port.replace(/\D/g, '')),
			shorttype: port.charAt(0),
		}
		pdat.type = { I: 'Input', O: 'Output' }[pdat.shorttype] || ''
		pdat.action = { I: 'selectSource', O: 'selectDestination' }[pdat.shorttype] || ''
		pdat.option = { I: 'source', O: 'destination' }[pdat.shorttype] || ''

		const selectionFeedbacks = [
			{
				feedbackId: pdat.option + 'Selected',
				options: {
					port: pdat.num,
				},
				style: {
					color: combineRgb(0, 255, 0),
					bgcolor: combineRgb(0, 70, 0),
				},
			},
			{
				feedbackId: 'route',
				options: {
					input: pdat.shorttype === 'I' ? pdat.num : 0,
					output: pdat.shorttype === 'O' ? pdat.num : 0,
				},
				style: {
					bgcolor: combineRgb(150, 0, 0),
				},
			},
		]

		this.presets['selection' + port] = {
			type: 'simple',
			name: 'Select ' + pdat.type + ' ' + pdat.num,
			style: {
				text: `${pdat.type}\\n$(${this.label}:name_${pdat.port})`,
				size: 'auto',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(30, 30, 30),
			},
			steps: [
				{
					down: [
						{
							actionId: pdat.action,
							options: {
								port: pdat.port,
							},
						},
					],
					up: [],
				},
			],
			feedbacks: selectionFeedbacks,
		}

		if (pdat.shorttype === 'I') {
			this.presets['selectAndTake' + port] = {
				type: 'simple',
				name: 'Select Input ' + pdat.num + ' and Take',
				style: {
					text: `Input\\n$(${this.label}:name_${pdat.port})`,
					size: 'auto',
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(60, 0, 0),
				},
				steps: [
					{
						down: [
							{
								actionId: pdat.action,
								options: {
									port: pdat.port,
								},
							},
							{
								actionId: 'takeSalvo',
								options: {},
							},
						],
						up: [],
					},
				],
				feedbacks: selectionFeedbacks,
			}
		}
	},

	/**
	 * One ready made button per preset stored on the device. Rebuilt from scratch so
	 * presets deleted on the device do not linger.
	 */
	createRecallPresets() {
		for (const presetId of Object.keys(this.presets)) {
			if (presetId.startsWith('recallPreset')) delete this.presets[presetId]
		}

		for (const preset of this.CHOICES_PRESETS) {
			this.presets['recallPreset' + preset.id] = {
				type: 'simple',
				name: 'Recall ' + preset.label,
				style: {
					text: `Preset\\n${preset.label}`,
					size: 'auto',
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 0, 100),
				},
				steps: [
					{
						down: [
							{
								actionId: 'preset',
								options: {
									preset: preset.id,
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [],
			}
		}
	},

	initPresets() {
		this.presets['take'] = {
			type: 'simple',
			name: 'Take Selected',
			style: {
				text: 'Take selected',
				size: 'auto',
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(180, 30, 30),
			},
			steps: [
				{
					down: [
						{
							actionId: 'takeSalvo',
							options: {},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		this.updatePresets()
	},

	updatePresets() {
		const members = {
			'select-input': [],
			'select-output': [],
			'select-input-and-take': [],
			'recall-preset': [],
			misc: [],
		}

		for (const presetId of Object.keys(this.presets)) {
			if (presetId.startsWith('selectAndTake')) {
				members['select-input-and-take'].push(presetId)
			} else if (presetId.startsWith('selectionI')) {
				members['select-input'].push(presetId)
			} else if (presetId.startsWith('selectionO')) {
				members['select-output'].push(presetId)
			} else if (presetId.startsWith('recallPreset')) {
				members['recall-preset'].push(presetId)
			} else {
				members.misc.push(presetId)
			}
		}

		const structure = SECTIONS.filter((section) => members[section.id].length > 0).map((section) => {
			return { id: section.id, name: section.name, definitions: members[section.id] }
		})

		this.setPresetDefinitions(structure, this.presets)
	},
}
