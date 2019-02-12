/*
 * Copyright 2018 IBM Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as Debug from 'debug'
const debug = Debug('plugins/openwhisk/preload')

import { PluginRequire, PreloadRegistration } from '@kui-shell/core/models/plugin'
import { getDefaultCommandContext } from '@kui-shell/core/core/command-tree'

/**
 * This is the module
 *
 */
const registration: PreloadRegistration = async (commandTree, prequire: PluginRequire, options?) => {
  if (getDefaultCommandContext()[0] === 'wsk' && getDefaultCommandContext()[1] === 'action') {
    const { auth } = await import('./lib/models/auth')

    if (auth.get()) {
      debug('we have openwhisk credentials available from startup')
      // capabilities.setHasAuth will be called from the auth model impl
    }
  }
}

export default registration
