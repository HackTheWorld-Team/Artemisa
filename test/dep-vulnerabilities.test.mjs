import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

describe('Dependency vulnerability fixes (issue #240)', () => {
  const frontendPkg = JSON.parse(fs.readFileSync(path.resolve('frontend/package.json'), 'utf8'));

  it('Next.js is updated to >=16.2.11 (latest stable with security patches)', () => {
    const version = frontendPkg.dependencies.next;
    const [major, minor, patch] = version.split('.').map(Number);
    // Compare as a version, not as independent components: asserting
    // `patch >= 11` rejected 16.3.8 even though it is newer than 16.2.11, so
    // any correct security bump past 16.2.x failed this test.
    const current = major * 1_000_000 + minor * 1_000 + patch;
    const minimum = 16 * 1_000_000 + 2 * 1_000 + 11;
    assert.ok(
      current >= minimum,
      `next ${version} must be at least 16.2.11 (the release that shipped the security patches)`,
    );
  });

  it('sharp is not a direct dependency (Next.js uses it optionally at runtime)', () => {
    const sharp = frontendPkg.dependencies.sharp;
    assert.equal(sharp, undefined, 'sharp should not be a direct dependency');
  });

  it('eslint-config-next removed (lint is optional, not part of build)', () => {
    const eslintNext = frontendPkg.devDependencies['eslint-config-next'];
    assert.equal(eslintNext, undefined, 'eslint-config-next should be removed');
  });

  it('runtime dependencies are gone with the runtime (#584)', () => {
    const rootPkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
    const removed = [
      '@modelcontextprotocol/sdk',
      'ai',
      '@ai-sdk/openai',
      '@ai-sdk/anthropic',
      'openai',
      '@anthropic-ai/sdk',
      'better-sqlite3',
    ];
    for (const dep of removed) {
      assert.equal(rootPkg.dependencies[dep], undefined, `${dep} should not be a backend dependency`);
      assert.equal(rootPkg.devDependencies[dep], undefined, `${dep} should not be a backend devDependency`);
    }
    assert.equal(rootPkg.devDependencies['@types/better-sqlite3'], undefined, 'sqlite types should be removed');
  });

  it('next version is pinned (not a range) for reproducibility', () => {
    const version = frontendPkg.dependencies.next;
    assert.doesNotMatch(version, /[\^~]/, 'next should be pinned, not a range');
  });
});
