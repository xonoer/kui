/*
 * Copyright 2020 IBM Corporation
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

import Debug from 'debug'
import {
  Arguments,
  Registrar,
  Tab,
  RadioTable,
  RadioTableRow,
  radioTableCellToString,
  CellShould,
  Table,
  isTable,
  Row,
  KResponse
} from '@kui-shell/core'

import { getCurrentContext } from './contexts'
import commandPrefix from '../command-prefix'
import { doGet, doGetAsMMR, getFlags as flags } from './get'
import { isKubeResource } from '../../lib/model/resource'
import { KubeOptions, isTableRequest, isWatchRequest } from './options'

const debug = Debug('plugin-kubectl/controller/kubectl/get/namespace')

/**
 * Summarize the resources in the namespace indicated by the last
 * positional argument into a table, where resources are histogrammed
 * by kind.
 *
 */
export async function doSummarizeNamedNamespace(tab: Tab, ns: string): Promise<Table> {
  // otherwise, summarize resource count by kind in a table
  const response = await tab.REPL.qexec<Table>(`kubectl get all -n ${ns} -o custom-columns=KIND:.kind`)

  const resources = response.body
  const histogram = resources.reduce((M, { name: kind }) => {
    M[kind] = (M[kind] || 0) + 1
    return M
  }, {} as Record<string, number>)

  const header = {
    name: 'KIND',
    attributes: [{ key: 'COUNT', value: 'COUNT' }]
  }

  const body = Object.keys(histogram)
    .map(kind => ({
      name: kind,
      onclick: `kubectl get ${kind} -n ${ns}`,
      attributes: [
        {
          key: 'COUNT',
          value: histogram[kind].toLocaleString()
        }
      ]
    }))
    .sort((a, b) => histogram[b.name] - histogram[a.name]) // sort be decreasing count

  return {
    header,
    body
  }
}

/**
 * Summarize the resources in the namespace indicated by the last
 * positional argument into a table, where resources are histogrammed
 * by kind.
 *
 */
function doSummarizeNamespace(args: Arguments<KubeOptions>): Promise<Table> {
  // summarize this namespace
  const ns = args.argvNoOptions[args.argvNoOptions.length - 1]
  return doSummarizeNamedNamespace(args.tab, ns)
}

/**
 * Switch to the namespace indicated by the last positional argument,
 * then summarize the resources in that namespace in a table.
 *
 */
async function doSwitchNamespace(args: Arguments<KubeOptions>): Promise<true | Table> {
  // switch to this namespace
  const ns = args.argvNoOptions[args.argvNoOptions.length - 1]

  // this does the actual switch
  await args.REPL.qexec(`kubectl config set-context --current --namespace=${ns}`)

  let summarizeNamespaceOnSwitch = false
  try {
    summarizeNamespaceOnSwitch = require('@kui-shell/client/config.d/kubectl.json').summarizeNamespaceOnSwitch
  } catch (err) {
    debug('using default value for summarizeNamespaceOnSwitch', err)
  }

  if (!summarizeNamespaceOnSwitch) {
    // client config told us not to summarize namespace on switch
    return true
  }

  return doSummarizeNamespace(args)
}

/**
 * @return the currently active namespace in the currently selected context
 *
 */
async function doGetCurrentNamespace({ tab }: Arguments<KubeOptions>) {
  return (await getCurrentContext(tab)).metadata.namespace
}

/** Align the table model of outerCSS and css to CellShould hints */
function hintsFor(outerCSS: string, css: string): CellShould[] {
  const hints = [] as CellShould[]

  if (/hide-with-sidecar/.test(outerCSS)) {
    hints.push(CellShould.HideWithSidecar)
  }

  if (/green-background/.test(css)) {
    hints.push(CellShould.HaveGreenBadge)
  } else if (/yellow-background/.test(css)) {
    hints.push(CellShould.HaveYellowBadge)
  } else if (/red-background/.test(css)) {
    hints.push(CellShould.HaveRedBadge)
  } else if (/gray-background/.test(css)) {
    hints.push(CellShould.HaveGrayBadge)
  }

  return hints
}

/** Convert old Table row model to new RadioTable row model. */
export function t2rt({ name, attributes }: Row): RadioTableRow {
  return {
    nameIdx: 0,
    cells: [
      name,
      ...attributes.map(({ value, outerCSS, css }) => ({
        value,
        hints: hintsFor(outerCSS, css)
      }))
    ]
  }
}

/** Format as RadioTable */
async function asRadioTable(args: Arguments<KubeOptions>, { header, body }: Table): Promise<RadioTable> {
  const {
    metadata: { namespace: currentNamespace }
  } = await getCurrentContext(args.tab)

  const defaultSelectedIdx = body.findIndex(_ => _.name === currentNamespace)

  const radio: RadioTable = {
    apiVersion: 'kui-shell/v1',
    kind: 'RadioTable',
    title: 'Namespaces',
    defaultSelectedIdx,

    header: t2rt(header),
    body: body.map(t2rt).map(rtRow =>
      Object.assign(rtRow, {
        onSelect: () => {
          const ns = radioTableCellToString(rtRow.cells[rtRow.nameIdx])
          args.REPL.pexec(`namespace switch ns ${ns}`)
        }
      })
    )
  }

  // place default at the top of the table, unless it is selected, in
  // which case the view will take care of things
  const rowIdxForDefaultNS = body.findIndex(_ => _.name === 'default')
  if (rowIdxForDefaultNS !== 0 && rowIdxForDefaultNS !== defaultSelectedIdx && body.length > 2) {
    const defaultRow = radio.body[rowIdxForDefaultNS]
    radio.body.splice(rowIdxForDefaultNS, 1)
    radio.body.splice(1, 0, defaultRow)

    if (defaultSelectedIdx < rowIdxForDefaultNS) {
      radio.defaultSelectedIdx += 1
    }
  }

  return radio
}

/** Table -> RadioTable view transformer */
function viewTransformer(args: Arguments<KubeOptions>, response: KResponse) {
  if (isTable(response)) {
    if (isTableRequest(args) && !isWatchRequest(args)) {
      return asRadioTable(args, response)
    } else {
      return response
    }
  } else if (isKubeResource(response)) {
    return doGetAsMMR(args, response)
  } else {
    return response
  }
}

/**
 * Command registration flags for commands that we want to present as
 * a RadioTable.
 *
 */
const rtFlags = Object.assign({}, flags, { viewTransformer })

export default (commandTree: Registrar) => {
  commandTree.listen(`/${commandPrefix}/kubectl/get/namespaces`, doGet('kubectl'), rtFlags)
  commandTree.listen(`/${commandPrefix}/k/get/namespaces`, doGet('kubectl'), rtFlags)
  commandTree.listen(`/${commandPrefix}/kubectl/get/namespace`, doGet('kubectl'), rtFlags)
  commandTree.listen(`/${commandPrefix}/k/get/namespace`, doGet('kubectl'), rtFlags)
  commandTree.listen(`/${commandPrefix}/kubectl/get/ns`, doGet('kubectl'), rtFlags)
  commandTree.listen(`/${commandPrefix}/k/get/ns`, doGet('kubectl'), rtFlags)

  commandTree.listen(`/${commandPrefix}/namespace/current`, doGetCurrentNamespace, flags)
  commandTree.listen(`/${commandPrefix}/namespace/summarize`, doSummarizeNamespace, flags)
  commandTree.listen(`/${commandPrefix}/namespace/switch`, doSwitchNamespace, flags)
  commandTree.listen(`/${commandPrefix}/ns/switch`, doSwitchNamespace, flags)
}
