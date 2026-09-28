'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {describeLaunchError} = require('../lib/launch-errors.cjs');

test('Playwright spawn EPERM is a permission failure, not missing installation', () => {
  const error = new Error('browserType.launchPersistentContext: spawn EPERM\nCall log:\n  - <launching> C:\\Users\\private-user\\AppData\\Local\\Browser\\chrome.exe --user-data-dir=C:\\private-profile');
  const result = describeLaunchError(error);
  assert.equal(result.code, 'BROWSER_PERMISSION_DENIED');
  assert.doesNotMatch(result.message + result.action, /安装|private-user|private-profile|chrome\.exe/);
});

test('native EACCES and nested causes preserve permission diagnosis', () => {
  const cause = Object.assign(new Error('spawn failed'), {code: 'EACCES'});
  const result = describeLaunchError(new Error('Browser launch failed', {cause}));
  assert.equal(result.code, 'BROWSER_PERMISSION_DENIED');
});

test('permission denial wins over a missing fallback executable', () => {
  const failures = new AggregateError([
    new Error('spawn EPERM'),
    new Error("Executable doesn't exist at C:\\Users\\private-user\\chromium\\chrome.exe"),
  ], 'Browser attempts failed');
  assert.equal(describeLaunchError(failures).code, 'BROWSER_PERMISSION_DENIED');
});

test('missing browser is distinguished from a permission error', () => {
  for (const message of [
    "browserType.launchPersistentContext: Executable doesn't exist at C:\\private\\chrome.exe",
    "Chromium distribution 'msedge' is not found at C:\\private\\msedge.exe",
    'spawn /private/chromium ENOENT',
  ]) {
    const result = describeLaunchError(new Error(message));
    assert.equal(result.code, 'BROWSER_NOT_INSTALLED');
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test('Chromium profile lock reports close-duplicate guidance', () => {
  for (const message of [
    'user data directory is already in use',
    'Failed to create a ProcessSingleton for your profile directory.',
    'Failed to create /private/profile/SingletonLock: File exists (17)',
  ]) {
    const result = describeLaunchError(new Error(message));
    assert.equal(result.code, 'BROWSER_PROFILE_IN_USE');
    assert.doesNotMatch(result.message + result.action, /删除|private/);
  }
});

test('unknown failures do not infer missing installation or echo logs', () => {
  const result = describeLaunchError(new Error('Target page, context or browser has been closed\nsecret log content'));
  assert.equal(result.code, 'BROWSER_LAUNCH_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /secret|安装/);
  assert.ok(result.action);
});

test('empty, string, and circular errors remain safe to classify', () => {
  assert.equal(describeLaunchError(undefined).code, 'BROWSER_LAUNCH_FAILED');
  assert.equal(describeLaunchError('Access is denied').code, 'BROWSER_PERMISSION_DENIED');
  const error = new Error('unknown'); error.cause = error;
  assert.equal(describeLaunchError(error).code, 'BROWSER_LAUNCH_FAILED');
});
