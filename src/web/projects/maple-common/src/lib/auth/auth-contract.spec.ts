import contract from './auth-contract.json';

describe('auth contract fixture', () => {
  it('lists 14 endpoints', () => {
    expect((contract as { endpoints: unknown[] }).endpoints.length).toBe(14);
  });
});
