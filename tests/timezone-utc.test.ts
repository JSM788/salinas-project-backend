import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localTimeToUtc, utcToLocalTime, businessDate } from '../src/common/business-date';

test('localTimeToUtc and utcToLocalTime preserve wall-clock time across international timezones', () => {
  // Test 1: Peru (America/Lima - UTC-5)
  const limaUtc = localTimeToUtc('2026-11-12', '09:00', 'America/Lima');
  assert.equal(limaUtc.toISOString(), '2026-11-12T14:00:00.000Z');
  assert.equal(utcToLocalTime(limaUtc, 'America/Lima'), '09:00');
  assert.equal(businessDate(limaUtc, 'America/Lima'), '2026-11-12');

  // Test 2: Chile (America/Santiago - UTC-3 in Nov)
  const santiagoUtc = localTimeToUtc('2026-11-12', '09:00', 'America/Santiago');
  assert.equal(santiagoUtc.toISOString(), '2026-11-12T12:00:00.000Z');
  assert.equal(utcToLocalTime(santiagoUtc, 'America/Santiago'), '09:00');
  assert.equal(businessDate(santiagoUtc, 'America/Santiago'), '2026-11-12');

  // Test 3: Colombia (America/Bogota - UTC-5)
  const bogotaUtc = localTimeToUtc('2026-11-12', '09:00', 'America/Bogota');
  assert.equal(bogotaUtc.toISOString(), '2026-11-12T14:00:00.000Z');
  assert.equal(utcToLocalTime(bogotaUtc, 'America/Bogota'), '09:00');
  assert.equal(businessDate(bogotaUtc, 'America/Bogota'), '2026-11-12');

  // Test 4: Mexico City (America/Mexico_City - UTC-6)
  const mexicoUtc = localTimeToUtc('2026-11-12', '09:00', 'America/Mexico_City');
  assert.equal(mexicoUtc.toISOString(), '2026-11-12T15:00:00.000Z');
  assert.equal(utcToLocalTime(mexicoUtc, 'America/Mexico_City'), '09:00');
  assert.equal(businessDate(mexicoUtc, 'America/Mexico_City'), '2026-11-12');

  // Test 5: Spain (Europe/Madrid - UTC+1 in Nov)
  const madridUtc = localTimeToUtc('2026-11-12', '09:00', 'Europe/Madrid');
  assert.equal(madridUtc.toISOString(), '2026-11-12T08:00:00.000Z');
  assert.equal(utcToLocalTime(madridUtc, 'Europe/Madrid'), '09:00');
  assert.equal(businessDate(madridUtc, 'Europe/Madrid'), '2026-11-12');
});
