import type { CompanionStaticUpgradeScript } from '@companion-module/base'
import type { ModuleConfig } from './config.js'

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = [
	/*
	 * Place your upgrade scripts here
	 * Remember that once it has been added it cannot be removed!
	 *
	 * The ids of the actions, feedbacks, variables and settings kept from v2 are unchanged, so no script
	 * is needed for the move to the TypeScript rewrite.
	 */
]
