import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_AGENT_PLACEMENT_HEALTH_LINE,
  scoreAgentPlacement,
  type AgentPlacementHealthLine,
} from "./agentPlacement.ts";
import { EnvironmentId } from "./baseSchemas.ts";
import type { HostResourcesSnapshot } from "./resourceTelemetry.ts";

const GIB = 1024 * 1024 * 1024;
const NOW = Date.parse("2026-11-26T21:48:00.000Z");

function resources(overrides: Partial<HostResourcesSnapshot>): HostResourcesSnapshot {
  return {
    sampledAt: NOW - 1_000,
    cpuUtilization: 0.1,
    cpuCount: 16,
    availableMemoryBytes: 48 * GIB,
    totalMemoryBytes: 64 * GIB,
    loadAverage1m: 1.6,
    serverEventLoopUtilization: 0.05,
    freeDiskBytes: 67 * GIB,
    totalDiskBytes: 450 * GIB,
    cpuPressure: null,
    memoryPressure: null,
    ...overrides,
  };
}

describe("scoreAgentPlacement", () => {
  it("ranks idle high-weight Heron above loaded lower-weight AX102 despite huge AX102 disk", () => {
    const heron = scoreAgentPlacement({
      environmentId: EnvironmentId.make("env:heron"),
      label: "Heron (ax42)",
      weight: 100,
      now: NOW,
      line: { ...DEFAULT_AGENT_PLACEMENT_HEALTH_LINE, maxLoadPerCore: 2 },
      resources: resources({
        cpuCount: 16,
        loadAverage1m: 16 * 0.11,
        availableMemoryBytes: 48 * GIB,
        totalMemoryBytes: 64 * GIB,
        freeDiskBytes: 67 * GIB,
        totalDiskBytes: 450 * GIB,
      }),
      room: { cap: null, active: 0, held: 0, free: null },
    });
    const ax102 = scoreAgentPlacement({
      environmentId: EnvironmentId.make("env:ax102"),
      label: "ax102",
      weight: 40,
      now: NOW,
      line: { ...DEFAULT_AGENT_PLACEMENT_HEALTH_LINE, maxLoadPerCore: 2.5 },
      resources: resources({
        cpuCount: 32,
        loadAverage1m: 32 * 0.43,
        availableMemoryBytes: 96 * GIB,
        totalMemoryBytes: 128 * GIB,
        freeDiskBytes: 886 * GIB,
        totalDiskBytes: 1800 * GIB,
      }),
      room: { cap: null, active: 27, held: 0, free: null },
    });

    assert.isUndefined(heron.skipped);
    assert.isUndefined(ax102.skipped);
    assert.isAbove(heron.score, ax102.score);
  });

  it("ranks Heron above AX102 and forge on live PSI fleet telemetry", () => {
    const heronLine: AgentPlacementHealthLine = {
      maxLoadPerCore: 2,
      minAvailableMemoryRatio: 0.1,
      minFreeDiskBytes: 10 * GIB,
      maxServerEventLoopUtilization: 1,
      maxCpuPressure: 40,
    };
    const ax102Line: AgentPlacementHealthLine = {
      maxLoadPerCore: 2.5,
      minAvailableMemoryRatio: 0.05,
      minFreeDiskBytes: 10 * GIB,
      maxServerEventLoopUtilization: 1,
      maxCpuPressure: 40,
    };
    const forgeLine: AgentPlacementHealthLine = {
      maxLoadPerCore: 1.5,
      minAvailableMemoryRatio: 0.25,
      minFreeDiskBytes: 10 * GIB,
      maxServerEventLoopUtilization: 1,
      maxCpuPressure: 40,
    };

    const heron = scoreAgentPlacement({
      environmentId: EnvironmentId.make("env:heron"),
      label: "Heron (ax42)",
      weight: 100,
      now: NOW,
      line: heronLine,
      resources: resources({
        cpuCount: 16,
        loadAverage1m: 4.41,
        availableMemoryBytes: 49_261_817_856,
        totalMemoryBytes: 66_460_139_520,
        freeDiskBytes: 67_447_885_824,
        totalDiskBytes: 468_702_478_336,
        cpuPressure: 0.05,
        memoryPressure: 0,
      }),
      room: { cap: null, active: 0, held: 0, free: null },
    });
    const ax102 = scoreAgentPlacement({
      environmentId: EnvironmentId.make("env:ax102"),
      label: "ax102",
      weight: 40,
      now: NOW,
      line: ax102Line,
      resources: resources({
        cpuCount: 32,
        loadAverage1m: 19.45,
        availableMemoryBytes: 103_102_197_760,
        totalMemoryBytes: 134_552_252_416,
        freeDiskBytes: 884_936_704_000,
        totalDiskBytes: 1_883_405_279_232,
        cpuPressure: 10.21,
        memoryPressure: 0.41,
      }),
      room: { cap: null, active: 24, held: 0, free: null },
    });
    const forge = scoreAgentPlacement({
      environmentId: EnvironmentId.make("env:forge"),
      label: "forge",
      weight: 20,
      now: NOW,
      line: forgeLine,
      resources: resources({
        cpuCount: 4,
        loadAverage1m: 3.54,
        availableMemoryBytes: 10_512_838_656,
        totalMemoryBytes: 16_368_975_872,
        freeDiskBytes: 33_487_908_864,
        totalDiskBytes: 160_921_083_904,
        cpuPressure: 24.76,
        memoryPressure: 0,
      }),
      room: { cap: null, active: 0, held: 0, free: null },
    });

    assert.isAbove(heron.score, ax102.score);
    assert.isAbove(ax102.score, forge.score);
  });

  it("saturates disk headroom at healthy threshold and caps saturation at 100 GiB", () => {
    const scoreAt = (freeGiB: number, minFreeGiB = 10, totalGiB = 2_000) =>
      scoreAgentPlacement({
        environmentId: EnvironmentId.make("env:disk"),
        label: "disk-test",
        weight: 50,
        now: NOW,
        line: { ...DEFAULT_AGENT_PLACEMENT_HEALTH_LINE, minFreeDiskBytes: minFreeGiB * GIB },
        resources: resources({
          freeDiskBytes: freeGiB * GIB,
          totalDiskBytes: totalGiB * GIB,
        }),
      });

    const tight = scoreAt(15);
    const moderate = scoreAt(30);
    const healthy50 = scoreAt(50);
    const healthy100 = scoreAt(100);
    const huge900 = scoreAt(900);

    assert.isBelow(tight.score, moderate.score);
    assert.isBelow(moderate.score, healthy50.score);
    assert.equal(healthy50.score, healthy100.score);
    assert.equal(healthy100.score, huge900.score);

    const raisedLine80 = scoreAt(80, 20);
    const raisedLine100 = scoreAt(100, 20);
    const raisedLine900 = scoreAt(900, 20);
    assert.isBelow(raisedLine80.score, raisedLine100.score);
    assert.equal(raisedLine100.score, raisedLine900.score);

    const highLine100 = scoreAt(100, 40);
    const highLine500 = scoreAt(500, 40);
    assert.equal(highLine100.score, highLine500.score);
  });

  it("scales small disks against totalDiskBytes and preserves unknown-disk fallback", () => {
    const smallDisk = scoreAgentPlacement({
      environmentId: EnvironmentId.make("env:small"),
      label: "small",
      weight: 50,
      now: NOW,
      line: DEFAULT_AGENT_PLACEMENT_HEALTH_LINE,
      resources: resources({
        freeDiskBytes: 30 * GIB,
        totalDiskBytes: 40 * GIB,
      }),
    });
    const fullDisk = scoreAgentPlacement({
      environmentId: EnvironmentId.make("env:full"),
      label: "full",
      weight: 50,
      now: NOW,
      line: DEFAULT_AGENT_PLACEMENT_HEALTH_LINE,
      resources: resources({
        freeDiskBytes: 50 * GIB,
        totalDiskBytes: 500 * GIB,
      }),
    });
    assert.closeTo(smallDisk.score / fullDisk.score, 0.75, 1e-6);

    const { freeDiskBytes: _free, totalDiskBytes: _total, ...withoutDisk } = resources({});
    const noDisk = scoreAgentPlacement({
      environmentId: EnvironmentId.make("env:nodisk"),
      label: "nodisk",
      weight: 50,
      now: NOW,
      line: DEFAULT_AGENT_PLACEMENT_HEALTH_LINE,
      resources: withoutDisk,
    });
    assert.closeTo(noDisk.score / fullDisk.score, 0.1, 1e-6);
    assert.include(noDisk.note ?? "", "free disk");
  });

  it("scales uncapped rooms by D'Hondt occupancy 1 / (1 + active + held) to spread bursts organically", () => {
    const scoreWithRoom = (
      id: string,
      weight: number,
      cpuCount: number,
      active: number,
      held = 0,
    ) =>
      scoreAgentPlacement({
        environmentId: EnvironmentId.make(id),
        label: id,
        weight,
        now: NOW,
        line: DEFAULT_AGENT_PLACEMENT_HEALTH_LINE,
        resources: resources({
          cpuCount,
          loadAverage1m: cpuCount * 0.2,
          availableMemoryBytes: 48 * GIB,
          totalMemoryBytes: 64 * GIB,
          freeDiskBytes: 80 * GIB,
          totalDiskBytes: 400 * GIB,
        }),
        room: { cap: null, active, held, free: null },
      });

    const idle = scoreWithRoom("env:heron", 100, 16, 0, 0);
    const oneActive = scoreWithRoom("env:heron", 100, 16, 1, 0);
    const threeBusy = scoreWithRoom("env:heron", 100, 16, 2, 1);
    assert.closeTo(oneActive.score / idle.score, 0.5, 1e-6);
    assert.closeTo(threeBusy.score / idle.score, 0.25, 1e-6);

    const busyHeron = scoreWithRoom("env:heron", 100, 16, 6, 0);
    const idleForge = scoreWithRoom("env:forge", 65, 4, 0, 0);
    const busyAx102 = scoreWithRoom("env:ax102", 40, 32, 3, 0);
    assert.isAbove(idleForge.score, busyHeron.score);
    assert.isAbove(busyAx102.score, idleForge.score);
  });
});
