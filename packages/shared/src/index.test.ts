import { describe, it, expect } from 'vitest';
import { ENTITY_TYPES, isEntityType } from './index';

describe('shared domain types', () => {
  it('isEntityType returns true for a valid entity type', () => {
    expect(isEntityType('lld')).toBe(true);
  });

  it('isEntityType returns false for an invalid entity type', () => {
    expect(isEntityType('xxx')).toBe(false);
  });

  it('ENTITY_TYPES has length 8', () => {
    expect(ENTITY_TYPES).toHaveLength(8);
  });
});
