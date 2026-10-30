/**
 * Self-contained tests for validateGradingBands (backend). Run with:
 *   npx ts-node --transpile-only --project tsconfig.dev.json src/scripts/test-grading-validation.ts
 */
import { validateGradingBands, defaultComponentConfig } from '../grading-validation';

let pass = 0;
let fail = 0;

function assert(name: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log(`  PASS: ${name}`); }
  else { fail++; console.log(`  FAIL: ${name}${extra ? ` -> ${extra}` : ''}`); }
}

const canonical = [
  { grade: 'F',  minPercent: 0,  maxPercent: 33,  gp: 0,   status: 'FAIL' },
  { grade: 'D',  minPercent: 33, maxPercent: 40,  gp: 1,   status: 'PASS' },
  { grade: 'C',  minPercent: 40, maxPercent: 50,  gp: 2,   status: 'PASS' },
  { grade: 'B',  minPercent: 50, maxPercent: 60,  gp: 3,   status: 'PASS' },
  { grade: 'A-', minPercent: 60, maxPercent: 70,  gp: 3.5, status: 'PASS' },
  { grade: 'A',  minPercent: 70, maxPercent: 80,  gp: 4,   status: 'PASS' },
  { grade: 'A+', minPercent: 80, maxPercent: 100, gp: 5,   status: 'PASS' },
];

console.log('Running grading validation tests...');

// 1. Valid canonical passes.
{
  const r = validateGradingBands(canonical);
  assert('canonical bands are valid', r.valid, r.errors.join('; '));
  assert('no errors', r.errors.length === 0);
}

// 2. Gap between bands fails.
{
  const bands = [
    { grade: 'A', minPercent: 70, maxPercent: 100, gp: 4, status: 'PASS' },
    { grade: 'F', minPercent: 0, maxPercent: 60, gp: 0, status: 'FAIL' },
  ];
  const r = validateGradingBands(bands);
  assert('gap between bands fails', !r.valid);
  assert('gap error mentions gap', r.errors.some(e => e.toLowerCase().includes('gap')), '');
}

// 3. Overlap fails.
{
  const bands = [
    { grade: 'A', minPercent: 60, maxPercent: 100, gp: 4, status: 'PASS' },
    { grade: 'B', minPercent: 50, maxPercent: 70, gp: 3, status: 'PASS' },
    { grade: 'F', minPercent: 0, maxPercent: 50, gp: 0, status: 'FAIL' },
  ];
  const r = validateGradingBands(bands);
  assert('overlap fails', !r.valid);
  assert('overlap error mentions overlap', r.errors.some(e => e.toLowerCase().includes('overlap')), '');
}

// 4. GP ordering violation (higher band lower GP) fails.
{
  const bands = [
    { grade: 'A', minPercent: 80, maxPercent: 100, gp: 4, status: 'PASS' },
    { grade: 'B', minPercent: 0, maxPercent: 80, gp: 5, status: 'PASS' },
  ];
  const r = validateGradingBands(bands);
  assert('GP ordering violation fails', !r.valid);
  assert('GP ordering error present', r.errors.some(e => e.toLowerCase().includes('gp ordering')), '');
}

// 5. Duplicate grade names fail.
{
  const bands = [
    { grade: 'A', minPercent: 80, maxPercent: 100, gp: 5, status: 'PASS' },
    { grade: 'A', minPercent: 0, maxPercent: 80, gp: 0, status: 'FAIL' },
  ];
  const r = validateGradingBands(bands);
  assert('duplicate grade fails', !r.valid);
  assert('duplicate error mentions duplicate', r.errors.some(e => e.toLowerCase().includes('duplicate')), '');
}

// 6. Missing FAIL band fails.
{
  const bands = [
    { grade: 'A+', minPercent: 80, maxPercent: 100, gp: 5, status: 'PASS' },
    { grade: 'A',  minPercent: 0, maxPercent: 80, gp: 4, status: 'PASS' },
  ];
  const r = validateGradingBands(bands);
  assert('missing FAIL fails', !r.valid);
  assert('FAIL required error present', r.errors.some(e => e.toLowerCase().includes('fail')), '');
}

// 7. Min must be less than max.
{
  const bands = [
    { grade: 'A', minPercent: 80, maxPercent: 100, gp: 5, status: 'PASS' },
    { grade: 'F', minPercent: 60, maxPercent: 60, gp: 0, status: 'FAIL' },
  ];
  const r = validateGradingBands(bands);
  assert('min >= max fails', !r.valid);
}

// 8. Coverage: must start at 0 and end at 100.
{
  const bands = [
    { grade: 'A', minPercent: 10, maxPercent: 100, gp: 4, status: 'PASS' },
    { grade: 'F', minPercent: 0, maxPercent: 10, gp: 0, status: 'FAIL' },
  ];
  // Starts at 0, ends at 100, no gaps: valid.
  const r1 = validateGradingBands(bands);
  assert('fully covering 2 bands valid', r1.valid, r1.errors.join('; '));

  const bands2 = [
    { grade: 'A', minPercent: 20, maxPercent: 100, gp: 4, status: 'PASS' },
    { grade: 'F', minPercent: 0, maxPercent: 10, gp: 0, status: 'FAIL' },
  ];
  const r2 = validateGradingBands(bands2);
  assert('not starting at 0 with gap fails', !r2.valid);
}

// 9. Duplicate GP allowed (not a violation).
{
  const bands = [
    { grade: 'A', minPercent: 80, maxPercent: 100, gp: 4, status: 'PASS' },
    { grade: 'B', minPercent: 0, maxPercent: 80, gp: 4, status: 'PASS' }, // same GP, higher band equal not lower -> OK? 80 band GP4, 0 band GP4 -> next.gp(4) < prev.gp(4)? no. valid ordering (equal OK).
  ];
  const r = validateGradingBands(bands);
  // gp ordering: 80 band gp 4, 0 band gp 4. Sorted by min: [0:gp4, 80:gp4]. For i=0: sorted[1].gp(4) < sorted[0].gp(4)? no. So valid ordering.
  assert('duplicate GP is allowed', r.valid || !r.errors.some(e => e.toLowerCase().includes('gp ordering')), r.errors.join('; '));
}

// 10. Band count: >10 fails.
{
  const many = [];
  for (let i = 0; i < 11; i++) {
    many.push({ grade: `G${i}`, minPercent: i * 10, maxPercent: i === 10 ? 100 : i * 10 + 10, gp: 5 - Math.floor(i / 3), status: i === 10 ? 'FAIL' : 'PASS' });
  }
  // This may have overlap issues, so just check count error is present.
  const r = validateGradingBands(many);
  assert('>10 bands fails', r.errors.some(e => e.toLowerCase().includes('maximum 10')), '');
}

// 11. <2 bands fails.
{
  const one = [{ grade: 'A', minPercent: 0, maxPercent: 100, gp: 4, status: 'PASS' }];
  const r = validateGradingBands(one);
  assert('<2 bands fails', r.errors.some(e => e.toLowerCase().includes('at least 2')), '');
}

console.log('\n--- defaultComponentConfig (universal 100 / pass 33 scheme) ---');
{
  const d = defaultComponentConfig(100, { mcqIncluded: false, practicalIncluded: false });
  assert('written-only 100: writtenFull 100', d.writtenFull === 100, String(d.writtenFull));
  assert('written-only 100: totalPass 33', d.totalPass === 33, String(d.totalPass));
  assert('written-only 100: writtenPass 33', d.writtenPass === 33, String(d.writtenPass));
  assert('written-only 100: mcqPass 0', d.mcqPass === 0, String(d.mcqPass));
}
{
  const d = defaultComponentConfig(100, { mcqIncluded: true, practicalIncluded: false });
  assert('w+mcq 100: writtenFull 70', d.writtenFull === 70, String(d.writtenFull));
  assert('w+mcq 100: writtenPass 23', d.writtenPass === 23, String(d.writtenPass));
  assert('w+mcq 100: mcqFull 30', d.mcqFull === 30, String(d.mcqFull));
  assert('w+mcq 100: mcqPass 10', d.mcqPass === 10, String(d.mcqPass));
  assert('w+mcq 100: totalPass 33', d.totalPass === 33, String(d.totalPass));
  assert('w+mcq 100: practicalFull 0', d.practicalFull === 0, String(d.practicalFull));
}
{
  const d = defaultComponentConfig(100, { mcqIncluded: true, practicalIncluded: true });
  assert('full 100: writtenFull 50', d.writtenFull === 50, String(d.writtenFull));
  assert('full 100: writtenPass 17', d.writtenPass === 17, String(d.writtenPass));
  assert('full 100: mcqFull 25', d.mcqFull === 25, String(d.mcqFull));
  assert('full 100: mcqPass 8', d.mcqPass === 8, String(d.mcqPass));
  assert('full 100: practicalFull 25', d.practicalFull === 25, String(d.practicalFull));
  assert('full 100: practicalPass 8', d.practicalPass === 8, String(d.practicalPass));
  assert('full 100: totalPass 33', d.totalPass === 33, String(d.totalPass));
}
{
  const d = defaultComponentConfig(50, { mcqIncluded: false, practicalIncluded: false });
  assert('written-only 50: writtenFull 50', d.writtenFull === 50, String(d.writtenFull));
  assert('written-only 50: writtenPass 17', d.writtenPass === 17, String(d.writtenPass));
  assert('written-only 50: totalPass 17', d.totalPass === 17, String(d.totalPass));
  assert('written-only 50: mcqFull 0', d.mcqFull === 0, String(d.mcqFull));
}

console.log('\n--- scale-aware validation (marks-based 50 scale) ---');
{
  const marksBands = [
    { grade: 'F',  minPercent: 0,  maxPercent: 16, gp: 0,   status: 'FAIL' },
    { grade: 'D',  minPercent: 17, maxPercent: 19, gp: 1,   status: 'PASS' },
    { grade: 'C',  minPercent: 20, maxPercent: 24, gp: 2,   status: 'PASS' },
    { grade: 'B',  minPercent: 25, maxPercent: 29, gp: 3,   status: 'PASS' },
    { grade: 'A-', minPercent: 30, maxPercent: 34, gp: 3.5, status: 'PASS' },
    { grade: 'A',  minPercent: 35, maxPercent: 39, gp: 4,   status: 'PASS' },
    { grade: 'A+', minPercent: 40, maxPercent: 50, gp: 5,   status: 'PASS' },
  ];
  const ok = validateGradingBands(marksBands, 50);
  assert('50-marks bands valid at scale 50', ok.valid, ok.errors.join('; '));
  assert('50-marks bands: no end-at-100 error', !ok.errors.some(e => e.toLowerCase().includes('must end at 100')), '');
  assert('50-marks bands: no gap errors', !ok.errors.some(e => e.toLowerCase().includes('gap')), '');
  // Same bands mis-validated as percentages should fail.
  const bad = validateGradingBands(marksBands, 100);
  assert('50-marks bands rejected at scale 100', !bad.valid, '');
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
