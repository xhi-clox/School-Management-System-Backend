/**
 * Server-side validation for grading bands (the % ranges, grade labels, GP and
 * pass/fail status assigned to a grading template).
 *
 * Rules enforced:
 *   1. 2-10 bands per template.
 *   2. Grade names unique and non-empty within the template.
 *   3. minPercent < maxPercent, both within 0-100.
 *   4. GP ordering: a higher percentage band cannot have a lower GP than any
 *      lower percentage band. GPs support decimals; duplicate GPs allowed.
 *   5. At least one PASS and one FAIL band.
 *   6. Bands collectively cover 0-100% with no overlaps or gaps.
 *      (min inclusive, max exclusive except the final 100% band.)
 */

export interface GradingBandInput {
  grade: string;
  minPercent: number;
  maxPercent: number;
  gp: number;
  status: string;
}

export interface GradingBandValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const EPS = 0.0001;

export function validateGradingBands(bands: GradingBandInput[], maxScale: number = 100): GradingBandValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const scale = maxScale > 0 ? maxScale : 100;

  if (bands.length < 2) {
    errors.push('At least 2 grade bands are required.');
  }
  if (bands.length > 10) {
    errors.push('Maximum 10 grade bands are allowed.');
  }

  // Rule 2: unique, non-empty grade names.
  const seen = new Set<string>();
  for (const b of bands) {
    const name = (b.grade ?? '').trim();
    if (!name) {
      errors.push('Grade name cannot be empty.');
      continue;
    }
    if (seen.has(name)) {
      errors.push(`Duplicate grade name: "${name}".`);
    }
    seen.add(name);
  }

  // Rule 3: bounds (0..scale, where scale=100 for percentages / full marks for marks-based).
  for (const b of bands) {
    if (b.minPercent < 0 || b.minPercent > scale) {
      errors.push(`"${b.grade}": min must be between 0 and ${scale} (got ${b.minPercent}).`);
    }
    if (b.maxPercent < 0 || b.maxPercent > scale) {
      errors.push(`"${b.grade}": max must be between 0 and ${scale} (got ${b.maxPercent}).`);
    }
    if (b.minPercent >= b.maxPercent) {
      errors.push(`"${b.grade}": min (${b.minPercent}) must be less than max (${b.maxPercent}).`);
    }
  }

  // Rule 4: GP ordering (higher % must not have lower GP) + GP >= 0.
  const sorted = [...bands].sort((a, b) => a.minPercent - b.minPercent);
  for (const b of bands) {
    if (b.gp < 0) {
      errors.push(`"${b.grade}": GP cannot be negative (got ${b.gp}).`);
    }
    if (b.gp > 5) {
      warnings.push(`"${b.grade}": GP ${b.gp} is above the typical 0-5 range.`);
    }
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i + 1].gp < sorted[i].gp - EPS) {
      errors.push(
        `GP ordering violation: "${sorted[i + 1].grade}" (${sorted[i + 1].minPercent}%) has GP ${sorted[i + 1].gp}, ` +
        `which is lower than "${sorted[i].grade}" (${sorted[i].minPercent}%) GP ${sorted[i].gp}. ` +
        `A higher percentage band cannot have a lower GP.`
      );
    }
  }

  // Rule 5: at least one PASS and one FAIL.
  const statuses = bands.map((b) => (b.status || '').toUpperCase());
  const hasPass = statuses.includes('PASS');
  const hasFail = statuses.includes('FAIL');
  if (!hasPass) errors.push('At least one PASS band is required.');
  if (!hasFail) errors.push('At least one FAIL band is required.');

  // Rule 6: coverage 0..scale with no gaps/overlaps.
  if (bands.length > 0) {
    const s = [...sorted];
    if (s[0].minPercent !== 0) {
      errors.push(`Bands must start at 0${scale === 100 ? '%' : ' marks'}.`);
    }
    const last = s[s.length - 1];
    if (last.maxPercent !== scale) {
      errors.push(`Bands must end at ${scale}${scale === 100 ? '%' : ' marks'}.`);
    }
    for (let i = 0; i < s.length - 1; i++) {
      const gap = s[i + 1].minPercent - s[i].maxPercent;
      // For percentage scales (100) bands are continuous within EPS. For
      // marks-based scales (e.g. 50) marks are integers, so adjacent buckets
      // like [0..16] then [17..19] are contiguous (16 then 17) — allow a 1-step.
      const contiguousLimit = scale === 100 ? EPS : 1 + EPS;
      if (gap > contiguousLimit) {
        errors.push(
          `Gap detected: "${s[i].grade}" ends at ${s[i].maxPercent}${scale === 100 ? '%' : ''} but "${s[i + 1].grade}" starts at ${s[i + 1].minPercent}${scale === 100 ? '%' : ''}.`
        );
      }
      if (gap < -EPS) {
        errors.push(
          `Overlap detected: "${s[i].grade}" ends at ${s[i].maxPercent}${scale === 100 ? '%' : ''} overlapping "${s[i + 1].grade}" which starts at ${s[i + 1].minPercent}${scale === 100 ? '%' : ''}.`
        );
      }
    }
  }

  // Warning: FAIL bands normally use GP 0.
  for (const b of bands) {
    if ((b.status || '').toUpperCase() === 'FAIL' && b.gp !== 0) {
      warnings.push(`"${b.grade}" is a FAIL band but has GP ${b.gp}; FAIL bands normally use GP 0.`);
    }
  }

  // Normalize status to PASS/FAIL.
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// Universal default grading scheme (100 marks base, pass 33). Component full and
// pass marks are derived from which components are present:
//   - Written only          : 100 / pass 33
//   - Written + MCQ         : 70/23 + 30/10, overall pass 33
//   - Written + MCQ + Prac. : 50/17 + 25/8 + 25/8, overall pass 33
//   - Written only (50)     : 50 / pass 17
export interface ComponentDefaults {
  writtenFull: number;
  mcqFull: number;
  practicalFull: number;
  writtenPass: number;
  mcqPass: number;
  practicalPass: number;
  totalPass: number;
}

export function defaultComponentConfig(
  fullMarks?: number | null,
  opts: { mcqIncluded?: boolean; practicalIncluded?: boolean } = {}
): ComponentDefaults {
  const total = fullMarks && fullMarks > 0 ? fullMarks : 100;
  const mcqIncluded = !!opts.mcqIncluded;
  const practicalIncluded = !!opts.practicalIncluded;

  if (total === 50) {
    return {
      writtenFull: 50, mcqFull: 0, practicalFull: 0,
      writtenPass: 17, mcqPass: 0, practicalPass: 0,
      totalPass: 17,
    };
  }

  if (practicalIncluded) {
    return {
      writtenFull: 50, mcqFull: 25, practicalFull: 25,
      writtenPass: 17, mcqPass: 8, practicalPass: 8,
      totalPass: 33,
    };
  }
  if (mcqIncluded) {
    return {
      writtenFull: 70, mcqFull: 30, practicalFull: 0,
      writtenPass: 23, mcqPass: 10, practicalPass: 0,
      totalPass: 33,
    };
  }
  return {
    writtenFull: total, mcqFull: 0, practicalFull: 0,
    writtenPass: 33, mcqPass: 0, practicalPass: 0,
    totalPass: 33,
  };
}

