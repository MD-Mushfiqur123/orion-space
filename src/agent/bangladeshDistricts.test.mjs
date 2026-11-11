import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  BANGLADESH_DISTRICTS,
  findDistrictSector,
} from './bangladeshDistricts.js';

describe('Bangladesh Districts Registry', () => {
  it('contains all 64 districts', () => {
    const keys = Object.keys(BANGLADESH_DISTRICTS);
    assert.ok(
      keys.length >= 64,
      `Expected at least 64 districts, found ${keys.length}`,
    );
  });

  it('correctly resolves Pirojpur', () => {
    const p1 = findDistrictSector('Pirojpur');
    assert.ok(p1, 'Failed to find Pirojpur');
    assert.strictEqual(p1.id, 'pirojpur');
    assert.strictEqual(p1.division, 'Barisal');

    const p2 = findDistrictSector('পিরোজপুর');
    assert.ok(p2);
    assert.strictEqual(p2.id, 'pirojpur');

    const p3 = findDistrictSector('fly to pirojpur please');
    assert.ok(p3);
    assert.strictEqual(p3.id, 'pirojpur');
  });

  it('correctly resolves Barisal and other southern districts', () => {
    const b = findDistrictSector('Barisal');
    assert.ok(b);
    assert.strictEqual(b.id, 'barisal');

    const bh = findDistrictSector('Bhola');
    assert.ok(bh);
    assert.strictEqual(bh.id, 'bhola');

    const pt = findDistrictSector('Patuakhali');
    assert.ok(pt);
    assert.strictEqual(pt.id, 'patuakhali');
  });

  it('correctly resolves northern and eastern districts', () => {
    const s = findDistrictSector('Sylhet');
    assert.ok(s);
    assert.strictEqual(s.id, 'sylhet');

    const r = findDistrictSector('Rangpur');
    assert.ok(r);
    assert.strictEqual(r.id, 'rangpur');

    const c = findDistrictSector('Chittagong');
    assert.ok(c);
    assert.strictEqual(c.id, 'chittagong');
  });
});
