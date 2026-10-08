import { describe, expect, it } from 'vitest'
import { ownedCandidates } from '../src/dynamic-client-coordinator.js'

// Inventory rows from the Host name the DSH Session (`nxt-<episodeId>`) as their agent, not the product agent.
const loaded = [
  { pluginId: 'star-1', pluginRunId: 'run-1', packageId: 'pkg-1', agentId: 'nxt-eps_example' },
  { pluginId: 'page-2', pluginRunId: 'run-2', packageId: 'pkg-2', agentId: 'nxt-eps_example' },
]

describe('ownedCandidates', () => {
  it('gives the active product agent every loaded candidate even though rows carry the Session id', () => {
    expect(ownedCandidates(loaded, 'agt_example', 'agt_example')).toEqual([
      { pluginId: 'star-1', pluginRunId: 'run-1' },
      { pluginId: 'page-2', pluginRunId: 'run-2' },
    ])
  })

  it('gives other agents nothing while one Episode is active', () => {
    expect(ownedCandidates(loaded, 'agt_example', 'agt_other')).toEqual([])
  })

  it('gives nobody candidates when no Episode is active', () => {
    expect(ownedCandidates(loaded, undefined, 'agt_example')).toEqual([])
  })
})
