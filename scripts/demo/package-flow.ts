/**
 * Package lifecycle for the demo's drift story: publish a fresh package at version 1, and upgrade it later.
 *
 * - `mockPackageFlow` registers the package and its upgrade in MockTatum, for the mock demo and its tests.
 * - `suiCliPackageFlow` publishes and upgrades `scripts/demo/move` on Sui TESTNET with the Sui CLI and the separate,
 *   gitignored config under `.buiry-local/sui-testnet/`. It dry-runs every transaction first, refuses any network
 *   other than testnet, and never prints the CLI or config path, the keystore or any key.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSuiNetwork } from '../../packages/core/src/index.js';
import type { FixtureRecord, MockTatum } from '../../packages/chain/src/index.js';

export interface PackageStep {
  /** The package id of this version. */
  packageId: string;
  /** The transaction digest that created it. */
  digest: string;
  version: number;
}

export interface PackageFlow {
  /** Publish a fresh package at version 1. */
  publish(): Promise<PackageStep>;
  /** Upgrade the package published by `publish` to version 2. */
  upgrade(): Promise<PackageStep>;
}

/** Sui Mainnet chain id as gRPC reports it (seen live, L-T2). The CLI flow refuses it outright. */
export const SUI_MAINNET_CHAIN_ID = '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S';

// ---------------------------------------------------------------- mock

/** A package that MockTatum knows at version 1, upgraded on demand. Deterministic ids for tests. */
export function mockPackageFlow(tatum: MockTatum, network = 'sui:mainnet'): PackageFlow {
  const v1 = '0x' + 'f1'.repeat(32);
  const v2 = '0x' + 'f2'.repeat(32);
  const cap = '0x' + 'ca'.repeat(32);
  const pubDigest = 'FreshPub1111111111111111111111111111111111111';
  const upgDigest = 'FreshUpg2222222222222222222222222222222222222';
  const versions = (n: number) => [
    { packageId: v1, version: '1' },
    ...(n > 1 ? [{ packageId: v2, version: '2' }] : []),
  ];
  const pkgRecord = (key: string, n: number): FixtureRecord => ({
    kind: 'package_versions',
    network,
    key,
    response: { versions: versions(n) },
  });
  const txRecord = (digest: string, changed: Record<string, unknown>[]): FixtureRecord => ({
    kind: 'transaction',
    network,
    key: digest,
    response: {
      digest,
      checkpoint: '1',
      timestamp: { seconds: '1792000000', nanos: 0 },
      effects: { status: { success: true }, epoch: '800', changedObjects: changed },
    },
  });
  return {
    async publish() {
      tatum.add(pkgRecord(v1, 1));
      tatum.add(
        txRecord(pubDigest, [
          {
            objectId: v1,
            idOperation: 'CREATED',
            outputState: 'OUTPUT_OBJECT_STATE_PACKAGE_WRITE',
            outputVersion: '1',
          },
        ]),
      );
      return { packageId: v1, digest: pubDigest, version: 1 };
    },
    async upgrade() {
      tatum.add(pkgRecord(v1, 2));
      tatum.add(pkgRecord(v2, 2));
      tatum.add(
        txRecord(upgDigest, [
          {
            objectId: v2,
            idOperation: 'CREATED',
            outputState: 'OUTPUT_OBJECT_STATE_PACKAGE_WRITE',
            outputVersion: '2',
          },
          {
            objectId: cap,
            idOperation: 'NONE',
            outputState: 'OUTPUT_OBJECT_STATE_OBJECT_WRITE',
            inputVersion: '1',
            outputVersion: '2',
            objectType:
              '0x0000000000000000000000000000000000000000000000000000000000000002::package::UpgradeCap',
          },
        ]),
      );
      return { packageId: v2, digest: upgDigest, version: 2 };
    },
  };
}

// ---------------------------------------------------------------- Sui CLI (testnet only)

interface CliOptions {
  /** Repository root (the CLI and config default to `.buiry-local/` under it). */
  root: string;
  /** Must be `sui:testnet`. */
  network: string;
  /** Chain id the Tatum gateway reports for that network; the CLI's chain must match it. */
  gatewayChainId: () => Promise<string>;
  log?: (s: string) => void;
  env?: Record<string, string | undefined>;
}

const MIN_BALANCE_MIST = 50_000_000n; // 0.05 SUI: a publish and an upgrade cost under 0.01 SUI on testnet.

export async function suiCliPackageFlow(o: CliOptions): Promise<PackageFlow> {
  const log = o.log ?? (() => {});
  const env = o.env ?? process.env;
  if (normalizeSuiNetwork(o.network) !== 'testnet')
    throw new Error(`the publish and upgrade steps run on testnet only; DEMO_NETWORK is ${o.network}`);
  const bin =
    env.SUI_CLI ??
    join(o.root, '.buiry-local', 'sui-cli', 'bin', process.platform === 'win32' ? 'sui.exe' : 'sui');
  const config = env.SUI_CLIENT_CONFIG ?? join(o.root, '.buiry-local', 'sui-testnet', 'client.yaml');
  if (!existsSync(bin))
    throw new Error('Sui CLI not found (expected under .buiry-local/sui-cli/bin, or set SUI_CLI)');
  if (!existsSync(config))
    throw new Error(
      'Sui client config not found (expected .buiry-local/sui-testnet/client.yaml, or set SUI_CLIENT_CONFIG)',
    );

  // Errors from the CLI can name local paths; strip them before they reach a log.
  const scrub = (s: string) => [o.root, bin, config].reduce((t, p) => t.split(p).join('<local>'), s);
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        bin,
        ['client', '--client.config', config, ...args],
        { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
        (err, stdout, stderr) => {
          if (err)
            reject(
              new Error(`sui client ${args[0]} failed: ${scrub(`${stderr}${stdout}`).trim().slice(-600)}`),
            );
          else resolve(stdout);
        },
      );
    });
  const json = (out: string) => {
    const a =
      out.indexOf('{') >= 0 && (out.indexOf('[') < 0 || out.indexOf('{') < out.indexOf('['))
        ? out.indexOf('{')
        : out.indexOf('[');
    if (a < 0) throw new Error('sui client returned no JSON');
    return JSON.parse(out.slice(a)) as Record<string, unknown>;
  };

  // Guard 1: the CLI talks to the same chain the gateway calls testnet, and it is not Mainnet.
  const cliChain = /Base58:\s*(\S+)/.exec(await run(['chain-identifier']))?.[1];
  const gwChain = await o.gatewayChainId();
  if (!cliChain || cliChain === SUI_MAINNET_CHAIN_ID || cliChain !== gwChain)
    throw new Error(
      `refusing to publish: the Sui CLI chain (${cliChain ?? 'unknown'}) is not the gateway's testnet chain (${gwChain})`,
    );
  log(`Sui CLI on testnet (chain ${cliChain.slice(0, 8)}...)`);

  // Guard 2: enough testnet SUI for a publish and an upgrade.
  const bal = json(await run(['balance', '--json'])) as unknown as [
    { balance: { coinType: string; balance: string } }[],
  ];
  const sui = bal[0]?.find((b) => /::sui::SUI$/.test(b.balance.coinType));
  if (!sui || BigInt(sui.balance.balance) < MIN_BALANCE_MIST)
    throw new Error(
      'the throwaway address needs at least 0.05 testnet SUI: run `sui client faucet` with the .buiry-local config',
    );

  const work = await mkdtemp(join(tmpdir(), 'buiry-demo-pkg-'));
  const pkgDir = join(work, 'pkg');
  const installDir = join(work, 'build');
  const source = join(o.root, 'scripts', 'demo', 'move');
  await cp(join(source, 'Move.toml'), join(pkgDir, 'Move.toml'), { recursive: true });
  await cp(join(source, 'sources'), join(pkgDir, 'sources'), { recursive: true });
  const setRevision = async (n: number) => {
    const f = join(pkgDir, 'sources', 'demo.move');
    await writeFile(
      f,
      (await readFile(f, 'utf8')).replace(/(public fun revision\(\): u64 \{\s*)\d+/, `$1${n}`),
    );
  };

  type Effects = {
    digest?: string;
    effects?: { status?: { status?: string } };
    objectChanges?: Record<string, string>[];
  };
  const transact = async (label: string, args: string[]): Promise<PackageStep> => {
    const dry = json(await run([...args, '--dry-run', '--json'])) as Effects;
    if (dry.effects?.status?.status !== 'success') throw new Error(`${label} dry run did not succeed`);
    log(`${label}: dry run ok`);
    const real = json(await run([...args, '--json'])) as Effects;
    if (real.effects?.status?.status !== 'success') throw new Error(`${label} did not succeed`);
    const pub = real.objectChanges?.find((c) => c.type === 'published');
    if (!pub || !real.digest) throw new Error(`${label}: no published package in the result`);
    log(`${label}: package ${pub.packageId} version ${pub.version}, transaction ${real.digest}`);
    return { packageId: pub.packageId!, digest: real.digest, version: Number(pub.version) };
  };

  let cap: string | undefined;
  return {
    async publish() {
      await setRevision(1);
      const step = await transact('publish (testnet)', ['publish', pkgDir, '--install-dir', installDir]);
      const published = await readFile(join(installDir, 'Published.toml'), 'utf8');
      cap = /upgrade-capability\s*=\s*"([^"]+)"/.exec(published)?.[1];
      if (!cap) throw new Error('publish did not record an upgrade capability');
      return step;
    },
    async upgrade() {
      if (!cap) throw new Error('upgrade before publish');
      await setRevision(2);
      // The CLI writes Published.toml to the install directory but reads it from the package directory.
      await cp(join(installDir, 'Published.toml'), join(pkgDir, 'Published.toml'));
      const step = await transact('upgrade (testnet)', [
        'upgrade',
        pkgDir,
        '--install-dir',
        installDir,
        '-c',
        cap,
      ]);
      await rm(work, { recursive: true, force: true });
      return step;
    },
  };
}
