/**
 * Golden pins for every shipped schema migration of every store this
 * application provisions (storage package and app). A shipped migration's
 * checksum is recorded on every database it ran on, so editing one makes those
 * databases fail a development start and warn in production. A failure here
 * means a shipped migration changed: revert it and add a new migration. Only
 * a NEW migration (or a new store) adds a row here.
 */
import { schemaMigrationChecksum } from '@openmaic/storage/pg-migrations';
import { describe, expect, it } from 'vitest';

import { APP_SCHEMA_STORES } from '@/lib/persistence/schema-stores';

const SHIPPED: readonly (readonly [
  store: string,
  version: number,
  name: string,
  transaction: boolean,
  checksum: string,
])[] = [
  [
    'runtime',
    1,
    'baseline',
    false,
    '87e3a83d8a718e1e7420e7507ac7f4c7810162e610fdff01997a5549b309063d',
  ],
  [
    'document',
    1,
    'baseline',
    false,
    '78ce8d4c7509425716c587ae8dbd163d5b5f5c81c6075ad4a74efaebc5a43aa9',
  ],
  [
    'document',
    2,
    'retire_document_stages_owner_id',
    true,
    'e79a611f5f57f5bf61edb3bf166d6744be1cc2c26d763349bfff246530689c2f',
  ],
  [
    'stage-meta',
    1,
    'baseline',
    false,
    '37854e43cc676f8bc81f6b402b7b8d819470778bfb1f6846012c2e4a18998202',
  ],
  [
    'stage-meta',
    2,
    'adopt_legacy_document_owners',
    true,
    'd53921614f5337fb5f300e788e037968aa10c6d303a52d1e0b5a493468354834',
  ],
  [
    'owner-merges',
    1,
    'baseline',
    false,
    '48295bbd5b7a47515ef9df8677f451052111d4e6f8fd04ad36c5e536df1ff0bf',
  ],
  [
    'legacy-import-bindings',
    1,
    'baseline',
    false,
    '604cdd8de13dc8cb8b5f70a97d2e37deba1bc7eb67b687d6d7b3b3d59c631c79',
  ],
  [
    'owner-material',
    1,
    'baseline',
    false,
    '569a37fa4e863644041b6e47abd55538ee882cfa2ecc51696410bebb106705be',
  ],
  [
    'owner-material',
    2,
    'byte_store_key',
    true,
    'fd7c8d270394855d7c6a14470ff60311d69dff3ddf4ba23befe0fff8ba664661',
  ],
  [
    'owner-material',
    3,
    'extraction_lease',
    true,
    'f021eaa2d167d4db15d893787ca5f32ae4a8b8d55a2386c6d9fc2a1c916434dd',
  ],
  [
    'owner-material',
    4,
    'touched_at',
    true,
    '3acac29dc0790eee5fdd4831810f19864eba2e9cef251a8804b49f74f1c48609',
  ],
  [
    'asset',
    1,
    'baseline',
    false,
    'd440298e2262b7ce4688848c2a8e23ca7d26b29e2b75cfc7011c0e60308178c5',
  ],
  [
    'legacy-classroom-imports',
    1,
    'baseline',
    false,
    '500638ed89d4d005069da8d0ec8be834d0554217300dada43a4afd2aac1f7268',
  ],
  [
    'workspace-model-config',
    1,
    'baseline',
    false,
    '82f0e38e650d3c51fd99ce8c24dab05b499cf30040f67ade7672dec064af104a',
  ],
  [
    'owner-agents',
    1,
    'baseline',
    true,
    'c7eaf8e6df8b27b2cb1a4f38ad908e7d790a4f8af8ee865268df19ed543231c8',
  ],
  [
    'agent-session',
    1,
    'baseline',
    false,
    '303bc60b42134420f6fc819d065aa7beb58950bdaaab17a2c9e531c1a77e301a',
  ],
  [
    'agent-session',
    2,
    'owner_event_type_known_v2',
    false,
    '5ca438832108d37a5c62efc951cc02bc4d2806c8aba39f1bd3cab426540507d7',
  ],
  [
    'agent-session-material',
    1,
    'baseline',
    false,
    '0fb90c35c638f1bdfafc106909c6bc9985b457aa158ed29f3930cfadd3edb89b',
  ],
  [
    'user-skill',
    1,
    'baseline',
    false,
    'b5f3e25dec1e8ce841e7f9fda08502f1fdddea25fdef85ed0d8ad1ad5aeebbad',
  ],
  [
    'generation-runs',
    1,
    'baseline',
    false,
    'be1c2c6a13bb6c787e90549e65904ff94c60e05a3faac309b8951eeb2ce4994b',
  ],
  [
    'generation-runs',
    2,
    'media_pending',
    true,
    '7f6f57d0c4ca3056e8a01de8fa243bc20db5e300099275aee7b5a10de5387edf',
  ],
  [
    'generation-runs',
    3,
    'run_report',
    true,
    '0280652b73aa1ec86924e6ef495705bb980f48781b851914571e10a60038de75',
  ],
  [
    'generation-runs',
    4,
    'outline_auto_confirm',
    true,
    '253db00a6eee8dfb35dc8aa435132be86e9e6039fde63eb07e66282a1d5f2866',
  ],
  [
    'generation-runs',
    5,
    'host_attributes',
    true,
    '73994d78d22a31a3b7c62f9ecb147a20bd70ffa17ab036f7bd6a75df682d9827',
  ],
  [
    'curriculum',
    1,
    'baseline',
    false,
    '0d0c90255c406df08de37e005274303bd8efdeed9a27ba630f22a0a1f9db1fbe',
  ],
  [
    'curriculum',
    2,
    'knowledge_points',
    true,
    'ed25fdcc1124b07fbd34a645d43835f8f756dccefbda1ba4f6978851412cbad5',
  ],
  [
    'curriculum',
    3,
    'knowledge_point_relations',
    true,
    '8682a4ab20bbeb736568c99c79a651c92afec966fba4671e987b5c583ffd98ed',
  ],
  [
    'curriculum',
    4,
    'generation_jobs',
    true,
    'fae3dedae82a4c2c90746cb929348b4943f1e2847e873ac45f1cb77bac307ed2',
  ],
  [
    'curriculum',
    5,
    'batches',
    true,
    'fc5a5c1419f9f5e05df3ed1d1486adde14b438c839e00f7a0d21856a7c6ab88e',
  ],
  [
    'curriculum',
    6,
    'export_jobs',
    true,
    '5a64e968a81460d905d01ebe6bf12aa94cedbb217684f061552ca73fedda174f',
  ],
  [
    'curriculum',
    7,
    'program_plan',
    true,
    'ab73309d438b62690f534d760fc1d387b5da2f1a8b030cfd0b3fc81ab3e67851',
  ],
  [
    'curriculum',
    8,
    'design_foundation',
    true,
    'f9320595ea00733593b08b8a0a43a5a2b145e3e903eb28b1d31ef9dfb27c1d8b',
  ],
  [
    'curriculum',
    9,
    'design_graph',
    true,
    'c23302a8fcc632b80703f6a992acde2a911d40c49a65f7dabaef8f7c3f9985c4',
  ],
  [
    'curriculum',
    10,
    'design_outline',
    true,
    'ad2fc32f5fdf5c3be1bfa997ff474087a59987c268f4043233a88ca472b86435',
  ],
  [
    'curriculum',
    11,
    'design_assessment',
    true,
    '17c63e8d9a8c46affbd87ad10a47ba109dbe09994ecadb2704a61a738fd1121a',
  ],
  [
    'curriculum',
    12,
    'design_audit',
    true,
    'f9426d94b945a75f00dfeb6a8d569db7d85c41b508ecc40c0b632f4b1569ca4a',
  ],
  [
    // Pinned late: migration 13 (`design_confirmation`, step 1's sign-off table)
    // shipped without this row, so this file has been failing since S6 — it lives
    // outside `tests/curriculum`, which is the command that always gets run.
    'curriculum',
    13,
    'design_confirmation',
    true,
    '33df13d6c3b5c35fd37da3be0f66e8751d6526b0fac5f0dfdac25569d981a569',
  ],
  [
    // Migration 14 gives a finding its address (`fingerprint`) so a decision can
    // outlive the review that re-derives it, and a unique index makes "one row
    // per defect" a guarantee instead of a convention.
    'curriculum',
    14,
    'design_finding_fingerprint',
    true,
    '7fc7c3253d865b84bab817547500105fa43e6b200eda833dac6a83ee13bf72e4',
  ],
  [
    // Migration 15 lifts chapters and sections out of each item's internal
    // outline into their own table, so the outline can exist before any item
    // does: the user's "先出章、再出节、最后才出目" was being skipped by the
    // cockpit, not merely reworded.
    'curriculum',
    15,
    'series_outline',
    true,
    '946930d452f69bcef6d3ca0ff2eb6b7093de7d91af72cdde38b0d8df529d8399',
  ],
];

/**
 * Stores no release provisions any more. A database may still record their
 * versions (the tables are left in place), so a new store must not take one
 * of these names: it would inherit those recorded versions.
 * - `classroom-generation-jobs`: the headless API's job table of pre-release
 *   builds, replaced by generation runs.
 */
const RETIRED_STORES: readonly string[] = ['classroom-generation-jobs'];

describe('shipped schema migrations', () => {
  it('reuse no retired store name', () => {
    for (const set of APP_SCHEMA_STORES) expect(RETIRED_STORES).not.toContain(set.store);
  });

  it('are exactly the pinned (store, version, name, transaction, checksum) rows', async () => {
    const actual: (readonly [string, number, string, boolean, string])[] = [];
    for (const set of APP_SCHEMA_STORES) {
      for (const migration of set.migrations) {
        actual.push([
          set.store,
          migration.version,
          migration.name,
          migration.transaction !== false,
          await schemaMigrationChecksum(migration),
        ]);
      }
    }
    expect(actual).toEqual(SHIPPED);
  });
});
