# 🚀 EXAM SYSTEM REFACTOR - IMPLEMENTATION GUIDE

## ✅ PHASE 1: COMPLETED (Database Migration)

**Status:** ✅ LIVE - All database changes applied successfully
- ExamSchedule now supports component marks (written/mcq/practical)
- Result model cleaned up (removed ct/cwhw/dgc, added isAbsent)
- GradingSystem now supports independent templates
- 5 existing schedules backfilled with component defaults

---

## 🔧 PHASE 2: BACKEND API UPDATES

### **2.1: Update Schedule Creation Endpoint**

**File:** `School-Management-System-Backend/src/index.ts`  
**Location:** Line 2995 - `app.post('/schedules')`

**Changes:**

```typescript
// REPLACE the schema validation (lines 2996-3008) with:
const schema = z.object({
  examId: z.string().min(1),
  classId: z.string().optional(),
  subjectId: z.string().min(1),
  date: z.string().min(1),
  startTime: z.string().min(1),
  endTime: z.string().min(1),
  
  // Total marks
  fullMarks: z.number().min(0),
  passMarks: z.number().min(0).optional(),
  
  // Component full marks
  writtenFullMarks: z.number().min(0).default(0),
  mcqFullMarks: z.number().min(0).default(0),
  practicalFullMarks: z.number().min(0).default(0),
  
  // Component pass marks
  writtenPassMarks: z.number().min(0).default(0),
  mcqPassMarks: z.number().min(0).default(0),
  practicalPassMarks: z.number().min(0).default(0),
  
  gradingTypeId: z.string().optional().nullable(),
  roomNo: z.string().optional(),
  sortOrder: z.number().optional(),
});

// ADD validation after line 3011:
const { writtenFullMarks, mcqFullMarks, practicalFullMarks, fullMarks } = parsed.data;
const componentSum = writtenFullMarks + mcqFullMarks + practicalFullMarks;

// Validate component sum equals fullMarks
if (componentSum !== fullMarks) {
  return res.status(400).json({
    error: 'Component marks must sum to total full marks',
    details: {
      written: writtenFullMarks,
      mcq: mcqFullMarks,
      practical: practicalFullMarks,
      sum: componentSum,
      expected: fullMarks
    }
  });
}

// At least one component must be non-zero
if (componentSum === 0) {
  return res.status(400).json({
    error: 'At least one component must have marks > 0'
  });
}

// UPDATE line 3030 to include component fields:
data: { 
  date: new Date(date), 
  startTime, 
  endTime, 
  fullMarks, 
  passMarks, 
  writtenFullMarks,
  mcqFullMarks,
  practicalFullMarks,
  writtenPassMarks,
  mcqPassMarks,
  practicalPassMarks,
  gradingTypeId: gradingTypeId || null, 
  roomNo: roomNo ?? null, 
  sortOrder 
}

// UPDATE line 3036-3048 to include component fields in create
```

---

### **2.2: Update Bulk Schedule Endpoint**

**Location:** Line 3068 - `app.post('/schedules/bulk')`

**Changes:**

```typescript
// UPDATE schema (line 3072-3084) to include component fields:
items: z.array(z.object({
  id: z.string().optional(),
  classId: z.string().nullable().optional(),
  subjectId: z.string().min(1),
  date: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  fullMarks: z.number().optional(),
  passMarks: z.number().optional(),
  writtenFullMarks: z.number().optional(),
  mcqFullMarks: z.number().optional(),
  practicalFullMarks: z.number().optional(),
  writtenPassMarks: z.number().optional(),
  mcqPassMarks: z.number().optional(),
  practicalPassMarks: z.number().optional(),
  gradingTypeId: z.string().optional().nullable(),
  roomNo: z.string().optional(),
  sortOrder: z.number().optional(),
})).min(1),

// ADD component validation inside the transaction loop (after line 3093):
// Validate component sum if fullMarks provided
if (item.fullMarks !== undefined && item.writtenFullMarks !== undefined) {
  const componentSum = (item.writtenFullMarks || 0) + (item.mcqFullMarks || 0) + (item.practicalFullMarks || 0);
  if (componentSum !== item.fullMarks) {
    throw new Error(`Component marks sum (${componentSum}) does not match fullMarks (${item.fullMarks}) for subject ${item.subjectId}`);
  }
}

// UPDATE data object (line 3094-3102) to include component fields:
if (item.writtenFullMarks !== undefined) data.writtenFullMarks = item.writtenFullMarks;
if (item.mcqFullMarks !== undefined) data.mcqFullMarks = item.mcqFullMarks;
if (item.practicalFullMarks !== undefined) data.practicalFullMarks = item.practicalFullMarks;
if (item.writtenPassMarks !== undefined) data.writtenPassMarks = item.writtenPassMarks;
if (item.mcqPassMarks !== undefined) data.mcqPassMarks = item.mcqPassMarks;
if (item.practicalPassMarks !== undefined) data.practicalPassMarks = item.practicalPassMarks;
```

---

### **2.3: Update Marks Entry with Component Validation**

**Location:** Line 1803 - `app.post('/results/bulk')`

**Changes:**

```typescript
// ADD after fetching schedules (line 1821):
// Validate each student's marks against component configuration
for (const m of marks) {
  const studentClass = studentMap.get(m.studentId)?.class;
  const schedule = schedules.find(s => s.class?.name === studentClass && s.subjectId === subjectId);
  
  if (!schedule) {
    return res.status(400).json({
      error: `No schedule found for student ${m.studentId} (class: ${studentClass})`
    });
  }
  
  const { writtenFullMarks, mcqFullMarks, practicalFullMarks } = schedule;
  
  // Strict component validation
  if ((writtenFullMarks || 0) === 0 && m.written !== 0) {
    return res.status(400).json({
      error: `Written marks must be 0 (component disabled)`,
      studentId: m.studentId
    });
  }
  if (m.written > (writtenFullMarks || 0)) {
    return res.status(400).json({
      error: `Written marks (${m.written}) exceed maximum (${writtenFullMarks})`,
      studentId: m.studentId
    });
  }
  
  if ((mcqFullMarks || 0) === 0 && m.mcq !== 0) {
    return res.status(400).json({
      error: `MCQ marks must be 0 (component disabled)`,
      studentId: m.studentId
    });
  }
  if (m.mcq > (mcqFullMarks || 0)) {
    return res.status(400).json({
      error: `MCQ marks (${m.mcq}) exceed maximum (${mcqFullMarks})`,
      studentId: m.studentId
    });
  }
  
  if ((practicalFullMarks || 0) === 0 && m.practical !== 0) {
    return res.status(400).json({
      error: `Practical marks must be 0 (component disabled)`,
      studentId: m.studentId
    });
  }
  if (m.practical > (practicalFullMarks || 0)) {
    return res.status(400).json({
      error: `Practical marks (${m.practical}) exceed maximum (${practicalFullMarks})`,
      studentId: m.studentId
    });
  }
  
  // Check absence
  const attendance = await prisma.examAttendance.findFirst({
    where: { examId, studentId: m.studentId, subjectId }
  });
  
  if (attendance && attendance.status === 'ABSENT') {
    return res.status(400).json({
      error: `Cannot enter marks for absent student`,
      studentId: m.studentId
    });
  }
  
  // Validate total
  const totalMarks = m.written + m.mcq + m.practical;
  if (totalMarks > (schedule.fullMarks || 100)) {
    return res.status(400).json({
      error: `Total marks (${totalMarks}) exceed full marks (${schedule.fullMarks})`,
      studentId: m.studentId
    });
  }
}

// ADD after marks validation, before transaction (around line 1878):
// Auto-create absent results
const absentStudents = await prisma.examAttendance.findMany({
  where: { examId, subjectId, status: 'ABSENT' }
});

// Within transaction, after upserting marks (around line 1974):
// Handle absent students
for (const absent of absentStudents) {
  await tx.result.upsert({
    where: {
      studentId_examId_subjectId: {
        studentId: absent.studentId,
        examId,
        subjectId
      }
    },
    update: {
      isAbsent: true,
      written: 0,
      mcq: 0,
      practical: 0,
      totalMarks: 0,
      grade: 'ABSENT',
      gp: 0
    },
    create: {
      studentId: absent.studentId,
      examId,
      subjectId,
      isAbsent: true,
      written: 0,
      mcq: 0,
      practical: 0,
      totalMarks: 0,
      grade: 'ABSENT',
      gp: 0
    }
  });
}
```

---

### **2.4: Update buildExamReport for Absences**

**Location:** Line 1983 - `async function buildExamReport`

**Changes:**

```typescript
// UPDATE student calculation loop (around line 2020-2058):
const students: any[] = [];
for (const { student, subjects } of studentMap.values()) {
  if (!subjects.length) continue;
  
  // Check if ALL subjects are absent
  const allAbsent = subjects.every(r => r.isAbsent);
  if (allAbsent) {
    students.push({
      studentId: student.id,
      name: student.name,
      admissionNo: student.admissionNo,
      avatar: student.avatar,
      class: student.class,
      section: student.section,
      roll: student.roll,
      status: 'ABSENT',
      totalMarks: 0,
      fullMarks: 0,
      percentage: 0,
      gpa: 0,
      grade: 'ABSENT',
      passed: false,
      failed: false,
      isAbsent: true,
      subjectCount: subjects.length
    });
    continue;
  }
  
  // Calculate marks only for non-absent subjects
  let totalMarks = 0, fullMarks = 0, gpSum = 0, gpCount = 0, creditSum = 0, failed = false;
  let hasAbsence = false;
  
  for (const r of subjects) {
    if (r.isAbsent) {
      hasAbsence = true;
      failed = true; // Any absence = overall fail
      continue;
    }
    totalMarks += r.totalMarks || 0;
    const fm = subjectFullMarksByClass.get(r.subjectId)?.get(student.class) ?? subjectDefaultFullMarks.get(r.subjectId) ?? 100;
    fullMarks += fm;
    const ch = subjectCreditHours.get(r.subjectId) ?? 1;
    if (r.gp != null) { gpSum += r.gp * ch; gpCount++; creditSum += ch; }
    if (r.grade && failGrades.has(r.grade)) failed = true;
  }
  
  const gpa = creditSum > 0 ? round2(gpSum / creditSum) : (gpCount ? round2(gpSum / gpCount) : 0);
  const percentage = fullMarks > 0 ? round2((totalMarks / fullMarks) * 100) : 0;
  let grade = '';
  if (failed) {
    grade = hasAbsence ? 'ABSENT' : 'F';
  } else if (grading.length) {
    const g = grading.find((x) => percentage >= x.minPercent && percentage <= x.maxPercent);
    grade = g ? g.grade : (grading[grading.length - 1]?.grade || '');
  }
  
  students.push({
    studentId: student.id,
    name: student.name,
    admissionNo: student.admissionNo,
    avatar: student.avatar,
    class: student.class,
    section: student.section,
    roll: student.roll,
    totalMarks: round2(totalMarks),
    fullMarks: round2(fullMarks),
    percentage,
    gpa,
    grade,
    passed: !failed,
    failed,
    hasAbsence,
    subjectCount: subjects.length
  });
}
```

---

### **2.5: Add Unpublish Endpoint**

**Location:** After line 2432 (after publish endpoint)

**ADD NEW ENDPOINT:**

```typescript
// Unpublish exam results (admin correction workflow)
app.post('/results/:examId/unpublish', authMiddleware, checkRole(['Admin']), async (req: Request, res: Response) => {
  try {
    const { examId } = req.params;
    const { reason } = req.body;
    
    const exam = await prisma.exam.findUnique({ where: { id: examId } });
    if (!exam) return res.status(404).json({ error: 'Exam not found' });
    
    if (exam.status !== 'Published') {
      return res.status(400).json({ 
        error: 'Exam is not published', 
        currentStatus: exam.status 
      });
    }
    
    // Transition back to Finalized (ready for corrections)
    await prisma.exam.update({
      where: { id: examId },
      data: {
        status: 'Finalized',
        updatedAt: new Date()
      }
    });
    
    // Update result status
    await prisma.result.updateMany({
      where: { examId },
      data: { status: 'Finalized' }
    });
    
    // Log unpublish action
    const actor = (req as any).user?.email || 'Unknown';
    console.log(`[AUDIT] Exam ${examId} unpublished by ${actor}. Reason: ${reason || 'Not provided'}`);
    
    res.json({ 
      success: true, 
      status: 'Finalized',
      message: 'Results unpublished. Marks can now be edited.',
      unpublishedBy: actor,
      unpublishedAt: new Date()
    });
  } catch (error: any) {
    console.error('Error unpublishing results:', error);
    res.status(500).json({ error: 'Failed to unpublish results', details: error.message });
  }
});
```

---

### **2.6: Add Publish Lock Enforcement**

**Location:** Line 1803 - Beginning of `app.post('/results/bulk')`

**ADD at the very start (after schema validation, around line 1816):**

```typescript
// Check if exam is published (prevent editing)
const exam = await prisma.exam.findUnique({ where: { id: examId } });

if (exam?.status === 'Published') {
  return res.status(403).json({
    error: 'Cannot edit marks for published results',
    message: 'Please unpublish the exam first to make corrections',
    examStatus: exam.status
  });
}
```

---

### **2.7: Remove Legacy Field References**

**FIND AND REMOVE all references to `ct`, `cwhw`, `dgc` in index.ts:**

**Line 1929-1931, 1943-1945:** DELETE
```typescript
// REMOVE these lines:
ct: 0,
cwhw: 0,
dgc: 0,
```

**Line 2744-2746, 2825-2827:** DELETE similar references

**Search for any other occurrences:**
```bash
# Run this command to find all references:
grep -n "ct:\|cwhw:\|dgc:" src/index.ts
```

---

## 🎨 PHASE 3: FRONTEND UPDATES

### **3.1: Update Exam Schedule Form**

**File:** `School-Management-system/src/app/(app)/exams/exam-schedule/page.tsx`

**Changes Required:**
- Add component marks input fields (written/mcq/practical)
- Add real-time validation that component sum = fullMarks
- Show visual breakdown/pie chart of marks distribution
- Auto-calculate component pass marks based on percentages

### **3.2: Update Marks Entry Page**

**File:** `School-Management-system/src/app/(app)/exams/marks-entry/page.tsx`

**Key Changes:**
```typescript
// Fetch schedule to get component configuration
const schedule = schedules.find(s => s.subjectId === selectedSubject);

// Render inputs dynamically based on component configuration
{schedule.writtenFullMarks > 0 ? (
  <Input
    type="number"
    max={schedule.writtenFullMarks}
    placeholder={`Written (Max: ${schedule.writtenFullMarks})`}
    disabled={student.isAbsent}
  />
) : (
  <div className="text-muted-foreground">N/A</div>
)}

{schedule.mcqFullMarks > 0 ? (
  <Input
    type="number"
    max={schedule.mcqFullMarks}
    placeholder={`MCQ (Max: ${schedule.mcqFullMarks})`}
    disabled={student.isAbsent}
  />
) : (
  <div className="text-muted-foreground">N/A</div>
)}

// Show absence status
{student.isAbsent && (
  <Badge variant="destructive">ABSENT - Marks Entry Blocked</Badge>
)}

// Auto-calculate total
const total = (written || 0) + (mcq || 0) + (practical || 0);
```

**Remove fallback to `ct` field:**
- Line 920 in `students/[id]/page.tsx`: Change `r.written ?? r.ct ?? '0'` to just `r.written ?? '0'`

### **3.3: Update Grading Settings**

**File:** `School-Management-system/src/app/(app)/settings/grading/page.tsx`

**Changes:**
- Add "Template Name" field
- Make ExamType selection optional (show as "Default for: Semester")
- Remove component pass mark configuration (moved to per-schedule)
- Show that templates are reusable

### **3.4: Update Results Display**

**Multiple files - Search for result display components**

**Key Changes:**
- Show "ABSENT" grade distinctly (red badge, different icon)
- Hide disabled components in result breakdown
- Analytics: separate "Absent" count from "Failed" count

### **3.5: Add Unpublish UI**

**File:** `School-Management-system/src/app/(app)/results/page.tsx`

**Add Button:**
```typescript
{exam.status === 'Published' && (
  <Button
    variant="destructive"
    onClick={() => setShowUnpublishDialog(true)}
  >
    Unpublish Results
  </Button>
)}

// Dialog component
<AlertDialog open={showUnpublishDialog} onOpenChange={setShowUnpublishDialog}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Unpublish Results?</AlertDialogTitle>
      <AlertDialogDescription>
        This will unlock the results for corrections. 
        Students will no longer be able to view them.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <Textarea
      placeholder="Reason for unpublishing (optional)"
      value={unpublishReason}
      onChange={(e) => setUnpublishReason(e.target.value)}
    />
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction onClick={handleUnpublish}>
        Unpublish
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

---

## 🧪 PHASE 4: TESTING

### **Test Scenario 1: Mixed Mark Configuration**
1. Create exam: "Test Exam 2026"
2. Schedule three subjects:
   - Math: Written=70, MCQ=30, Practical=0, Total=100
   - Drawing: Written=50, MCQ=0, Practical=0, Total=50
   - Science: Written=40, MCQ=20, Practical=40, Total=100
3. Try to enter marks exceeding limits → Should fail
4. Try to enter MCQ marks for Drawing → Should fail
5. Enter valid marks → Should succeed
6. Verify GPA calculation is correct with mixed marks

### **Test Scenario 2: Absence Workflow**
1. Mark student as ABSENT in exam attendance
2. Try to enter marks → Should fail with clear error
3. Verify result shows "ABSENT" status
4. Check analytics show absent count separately

### **Test Scenario 3: Publication Lock**
1. Enter marks and publish results
2. Try to edit marks → Should fail
3. Unpublish results
4. Edit marks → Should succeed
5. Republish → Should work

### **Test Scenario 4: Component Validation**
1. Try creating schedule where written + mcq + practical ≠ fullMarks → Should fail
2. Try entering written > writtenFullMarks → Should fail
3. Verify validation messages are clear and helpful

---

## 📝 PHASE 5: FINAL CHECKLIST

- [ ] All backend endpoints updated and tested
- [ ] All frontend forms support component marks
- [ ] Marks entry dynamically hides disabled components
- [ ] Absence blocking works correctly
- [ ] Publish/unpublish workflow functional
- [ ] Analytics distinguish absent from failed
- [ ] No references to ct/cwhw/dgc remain
- [ ] API documentation updated
- [ ] User training materials prepared
- [ ] Database backup taken before deployment

---

## 🚀 DEPLOYMENT SEQUENCE

1. **Database:** ✅ Already deployed and tested
2. **Backend:** Deploy updated index.ts
3. **Frontend:** Deploy updated React components
4. **Verification:** Run all test scenarios
5. **User Training:** Brief administrators on new workflow

---

## 📞 SUPPORT

If issues arise during implementation:
1. Check console logs for detailed error messages
2. Verify database migration was applied correctly
3. Ensure Prisma client was regenerated
4. Review validation error responses carefully

**Current Status:** Database migration complete. Backend and frontend updates ready to implement.
