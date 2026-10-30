import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const CLASSES = [
  { name: 'Play Group', section: 'A' },
  { name: 'Nursery', section: 'A' },
  { name: 'Kindergarten', section: 'A' },
  { name: 'Grade 1', section: 'A' },
  { name: 'Grade 1', section: 'B' },
  { name: 'Grade 2', section: 'A' },
  { name: 'Grade 2', section: 'B' },
  { name: 'Grade 3', section: 'A' },
  { name: 'Grade 3', section: 'B' },
  { name: 'Grade 4', section: 'A' },
  { name: 'Grade 4', section: 'B' },
  { name: 'Grade 5', section: 'A' },
  { name: 'Grade 5', section: 'B' },
  { name: 'Grade 6', section: 'A' },
  { name: 'Grade 7', section: 'A' },
  { name: 'Grade 8', section: 'A' },
  { name: 'Grade 9', section: 'A' },
  { name: 'Grade 10', section: 'A' },
];

const SUBJECTS = [
  { name: 'Bangla', code: 'BAN', type: 'Core' },
  { name: 'English', code: 'ENG', type: 'Core' },
  { name: 'Mathematics', code: 'MATH', type: 'Core' },
  { name: 'General Science', code: 'GS', type: 'Core' },
  { name: 'Social Science', code: 'SS', type: 'Core' },
  { name: 'ICT', code: 'ICT', type: 'Core' },
  { name: 'Religious Studies', code: 'RS', type: 'Core' },
  { name: 'Physical Education', code: 'PE', type: 'Co-curricular' },
  { name: 'Arts & Crafts', code: 'ART', type: 'Co-curricular' },
  { name: 'Agriculture', code: 'AGR', type: 'Elective' },
  { name: 'Home Economics', code: 'HE', type: 'Elective' },
  { name: 'Business Studies', code: 'BUS', type: 'Elective' },
];

const TEACHERS = [
  { name: 'Mr. Abdul Karim', employeeId: 'E101', subject: 'Bangla', email: 'abdul.karim@academify.edu', phone: '+8801700000001', designation: 'Senior Teacher', salary: 18000 },
  { name: 'Mrs. Fatema Begum', employeeId: 'E102', subject: 'Bangla', email: 'fatema.begum@academify.edu', phone: '+8801700000002', designation: 'Assistant Teacher', salary: 12000 },
  { name: 'Mr. Rafiq Islam', employeeId: 'E103', subject: 'English', email: 'rafiq.islam@academify.edu', phone: '+8801700000003', designation: 'Senior Teacher', salary: 18000 },
  { name: 'Mrs. Salma Akter', employeeId: 'E104', subject: 'English', email: 'salma.akter@academify.edu', phone: '+8801700000004', designation: 'Assistant Teacher', salary: 12000 },
  { name: 'Mr. Rahim Uddin', employeeId: 'E105', subject: 'Mathematics', email: 'rahim.uddin@academify.edu', phone: '+8801700000005', designation: 'Senior Teacher', salary: 20000 },
  { name: 'Mrs. Nusrat Jahan', employeeId: 'E106', subject: 'Mathematics', email: 'nusrat.jahan@academify.edu', phone: '+8801700000006', designation: 'Assistant Teacher', salary: 13000 },
  { name: 'Mr. Kamal Hossain', employeeId: 'E107', subject: 'General Science', email: 'kamal.hossain@academify.edu', phone: '+8801700000007', designation: 'Teacher', salary: 15000 },
  { name: 'Mrs. Shahana Parvin', employeeId: 'E108', subject: 'Social Science', email: 'shahana.parvin@academify.edu', phone: '+8801700000008', designation: 'Teacher', salary: 15000 },
  { name: 'Mr. Mizanur Rahman', employeeId: 'E109', subject: 'ICT', email: 'mizanur.rahman@academify.edu', phone: '+8801700000009', designation: 'Teacher', salary: 16000 },
  { name: 'Mrs. Roksana Yasmin', employeeId: 'E110', subject: 'Religious Studies', email: 'roksana.yasmin@academify.edu', phone: '+8801700000010', designation: 'Teacher', salary: 14000 },
  { name: 'Mr. Tanvir Ahmed', employeeId: 'E111', subject: 'Physical Education', email: 'tanvir.ahmed@academify.edu', phone: '+8801700000011', designation: 'Teacher', salary: 13000 },
  { name: 'Mrs. Mahfuza Khatun', employeeId: 'E112', subject: 'Arts & Crafts', email: 'mahfuza.khatun@academify.edu', phone: '+8801700000012', designation: 'Teacher', salary: 13000 },
  { name: 'Mr. Jamal Uddin', employeeId: 'E113', subject: 'Agriculture', email: 'jamal.uddin@academify.edu', phone: '+8801700000013', designation: 'Teacher', salary: 14000 },
  { name: 'Mrs. Sharmin Sultana', employeeId: 'E114', subject: 'Home Economics', email: 'sharmin.sultana@academify.edu', phone: '+8801700000014', designation: 'Teacher', salary: 14000 },
];

const STAFF = [
  { name: 'Mr. Altaf Hossain', employeeId: 'S101', designation: 'Accountant', department: 'Finance', email: 'altaf@academify.edu', phone: '+8801800000001' },
  { name: 'Mrs. Nasima Begum', employeeId: 'S102', designation: 'Librarian', department: 'Library', email: 'nasima@academify.edu', phone: '+8801800000002' },
  { name: 'Mr. Shakil Ahmed', employeeId: 'S103', designation: 'IT Officer', department: 'Administration', email: 'shakil@academify.edu', phone: '+8801800000003' },
  { name: 'Mrs. Rehana Parvin', employeeId: 'S104', designation: 'Office Assistant', department: 'Administration', email: 'rehana@academify.edu', phone: '+8801800000004' },
  { name: 'Mr. Sajjad Hossain', employeeId: 'S105', designation: 'Security Guard', department: 'Security', email: 'sajjad@academify.edu', phone: '+8801800000005' },
];

const FIRST_NAMES = [
  'Aarif', 'Bushra', 'Chowdhury', 'Dalia', 'Ehsan', 'Farhana', 'Golam', 'Habiba',
  'Iqbal', 'Jarin', 'Kawsar', 'Lamia', 'Mahin', 'Nabila', 'Omar', 'Pritom',
  'Rifat', 'Sabina', 'Tanim', 'Umme', 'Wasif', 'Xaman', 'Yamin', 'Zara',
  'Anika', 'Bilal', 'Crystal', 'Dhruba', 'Emon', 'Farzana', 'Gourab', 'Hasina',
  'Imran', 'Joya', 'Karishma', 'Liton', 'Mushfiq', 'Nusrat', 'Oishi', 'Puja',
  'Rakib', 'Sadia', 'Tasnim', 'Urmi', 'Vaskar', 'Walid', 'Yeasmin', 'Zubair',
];

const LAST_NAMES = [
  'Ahmed', 'Begum', 'Chowdhury', 'Das', 'Hossain', 'Islam', 'Khan', 'Miah',
  'Nath', 'Pervez', 'Rahman', 'Sarker', 'Talukder', 'Uddin', 'Wahid', 'Yusuf',
];

const GRADING_RULES = [
  { grade: 'A+', minPercent: 90, maxPercent: 100, gp: 5.0, status: 'PASS', writtenPass: 33, mcqPass: 33, totalPass: 40 },
  { grade: 'A', minPercent: 80, maxPercent: 89, gp: 4.0, status: 'PASS', writtenPass: 33, mcqPass: 33, totalPass: 40 },
  { grade: 'A-', minPercent: 70, maxPercent: 79, gp: 3.5, status: 'PASS', writtenPass: 33, mcqPass: 33, totalPass: 40 },
  { grade: 'B', minPercent: 60, maxPercent: 69, gp: 3.0, status: 'PASS', writtenPass: 33, mcqPass: 33, totalPass: 40 },
  { grade: 'C', minPercent: 50, maxPercent: 59, gp: 2.0, status: 'PASS', writtenPass: 33, mcqPass: 33, totalPass: 40 },
  { grade: 'D', minPercent: 40, maxPercent: 49, gp: 1.0, status: 'PASS', writtenPass: 33, mcqPass: 33, totalPass: 40 },
  { grade: 'F', minPercent: 0, maxPercent: 39, gp: 0.0, status: 'FAIL', writtenPass: 33, mcqPass: 33, totalPass: 40 },
];

const now = new Date();
const CURRENT_MONTH = now.getMonth() + 1;
const CURRENT_YEAR = now.getFullYear();
const BILLING_MONTH = `${CURRENT_YEAR}-${String(CURRENT_MONTH).padStart(2, '0')}`;

function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function gradeFor(percent: number) {
  const rule = GRADING_RULES.find((r) => percent >= r.minPercent && percent <= r.maxPercent);
  return rule || GRADING_RULES[GRADING_RULES.length - 1];
}

async function main() {
  // ---------- 1. Classes ----------
  console.log('Seeding classes...');
  const classes: Array<{ id: string; name: string; section: string }> = [];
  for (let i = 0; i < CLASSES.length; i++) {
    const c = CLASSES[i];
    let cls = await prisma.schoolClass.findFirst({ where: { name: c.name, section: c.section } });
    if (!cls) {
      cls = await prisma.schoolClass.create({ data: { name: c.name, section: c.section, teacherId: null } });
    }
    classes.push({ id: cls.id, name: c.name, section: c.section });
  }
  console.log(`  ${classes.length} classes ready`);

  // ---------- 2. Subjects ----------
  console.log('Seeding subjects...');
  for (const s of SUBJECTS) {
    await prisma.subject.upsert({ where: { code: s.code }, update: {}, create: s });
  }
  const subjectMap = new Map(SUBJECTS.map((s) => [s.name, s.code]));

  // ---------- 3. Teachers ----------
  console.log('Seeding teachers...');
  const teachers: any[] = [];
  for (const t of TEACHERS) {
    const teacher = await prisma.teacher.upsert({
      where: { employeeId: t.employeeId },
      update: { subject: t.subject, designation: t.designation, salary: t.salary },
      create: {
        name: t.name,
        employeeId: t.employeeId,
        subject: t.subject,
        email: t.email,
        phone: t.phone,
        designation: t.designation,
        salary: t.salary,
        joiningDate: new Date(`${CURRENT_YEAR - 2}-01-10`),
        status: 'Active',
      },
    });
    teachers.push(teacher);
  }
  console.log(`  ${teachers.length} teachers ready`);

  // Assign class teachers
  for (let i = 0; i < classes.length; i++) {
    const teacher = teachers[i % teachers.length];
    await prisma.schoolClass.update({ where: { id: classes[i].id }, data: { teacherId: teacher.id } });
  }

  // ---------- 4. Admission packages ----------
  console.log('Seeding admission packages...');
  for (const cls of classes) {
    const existing = await prisma.admissionPackage.findFirst({ where: { classId: cls.id } });
    if (existing) continue;
    const low = ['Play Group', 'Nursery', 'Kindergarten'].includes(cls.name);
    const mid = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5'].includes(cls.name);
    const base = low ? 3000 : mid ? 4000 : 5000;
    await prisma.admissionPackage.create({
      data: {
        name: `${cls.name} ${cls.section} Admission Package`,
        session: `${CURRENT_YEAR}-${CURRENT_YEAR + 1}`,
        classId: cls.id,
        description: `Standard admission package for ${cls.name} ${cls.section}`,
        isActive: true,
        feeItems: {
          create: [
            { name: 'Admission Fee', amount: base },
            { name: 'Tuition Fee (Monthly)', amount: Math.round(base * 0.6) },
            { name: 'Examination Fee', amount: Math.round(base * 0.2) },
            { name: 'Library Fee', amount: Math.round(base * 0.1) },
            { name: 'Laboratory Fee', amount: Math.round(base * 0.15) },
          ],
        },
      },
    });
  }
  console.log('  packages ready');

  // ---------- 5. Students + logins + guardians ----------
  console.log('Seeding students...');
  let studentCount = 0;
  for (let ci = 0; ci < classes.length; ci++) {
    const cls = classes[ci];
    const perClass = 10;
    for (let r = 1; r <= perClass; r++) {
      const rand = rng(ci * 1000 + r);
      const firstName = FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)];
      const lastName = LAST_NAMES[Math.floor(rand() * LAST_NAMES.length)];
      const gender = rand() > 0.5 ? 'Female' : 'Male';
      const admissionNo = `ADM-${CURRENT_YEAR}-${String(ci * perClass + r).padStart(4, '0')}`;
      const dob = new Date(`${CURRENT_YEAR - 5 - Math.floor(rand() * 6)}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`);

      const student = await prisma.student.upsert({
        where: { admissionNo },
        update: {
          class: cls.name,
          section: cls.section,
          roll: r,
          status: 'Active',
          academicYear: `${CURRENT_YEAR}-${CURRENT_YEAR + 1}`,
        },
        create: {
          name: `${firstName} ${lastName}`,
          admissionNo,
          class: cls.name,
          section: cls.section,
          roll: r,
          gender,
          dob,
          bloodGroup: ['A+', 'B+', 'O+', 'AB+', 'A-', 'O-'][Math.floor(rand() * 6)],
          religion: rand() > 0.3 ? 'Islam' : 'Hinduism',
          banglaName: `${firstName} ${lastName}`,
          guardianPhone: `+88017${String(10000000 + Math.floor(rand() * 89999999))}`,
          fatherName: `Mr. ${lastName} ${firstName}`,
          motherName: `Mrs. ${LAST_NAMES[(LAST_NAMES.indexOf(lastName) + 1) % LAST_NAMES.length]} ${firstName}`,
          phone: `+88016${String(10000000 + Math.floor(rand() * 89999999))}`,
          email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${ci * perClass + r}@student.academify.edu`,
          address: `House ${1 + Math.floor(rand() * 500)}, Road ${1 + Math.floor(rand() * 50)}, Dhaka`,
          nationality: 'Bangladeshi',
          status: 'Active',
          academicYear: `${CURRENT_YEAR}-${CURRENT_YEAR + 1}`,
          shift: 'Morning',
          admissionDate: new Date(`${CURRENT_YEAR}-01-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`),
        },
      });

      await prisma.studentLogin.upsert({
        where: { studentId: student.id },
        update: {},
        create: {
          studentId: student.id,
          username: admissionNo,
          password: 'password',
          role: 'Student',
          status: 'Active',
        },
      });

      await prisma.guardian.upsert({
        where: { studentId: student.id },
        update: {},
        create: {
          studentId: student.id,
          fatherName: `Mr. ${lastName} ${firstName}`,
          fatherPhone: `+88017${String(10000000 + Math.floor(rand() * 89999999))}`,
          fatherOccupation: ['Business', 'Service', 'Farmer', 'Teacher'][Math.floor(rand() * 4)],
          motherName: `Mrs. ${LAST_NAMES[(LAST_NAMES.indexOf(lastName) + 1) % LAST_NAMES.length]} ${firstName}`,
          motherPhone: `+88018${String(10000000 + Math.floor(rand() * 89999999))}`,
          motherOccupation: 'Homemaker',
          guardianName: `Mr. ${lastName} ${firstName}`,
          guardianPhone: `+88017${String(10000000 + Math.floor(rand() * 89999999))}`,
          guardianRelation: 'Father',
        },
      });
      studentCount++;
    }
  }
  console.log(`  ${studentCount} students ready`);

  // ---------- 6. Exam types + grading ----------
  console.log('Seeding exam types + grading...');
  const examTypes: any[] = [];
  for (const name of ['First Term', 'Second Term', 'Final Exam']) {
    const et = await prisma.examType.upsert({ where: { name }, update: {}, create: { name } });
    examTypes.push(et);
    await prisma.gradingSystem.deleteMany({ where: { examTypeId: et.id } });
    for (const rule of GRADING_RULES) {
      await prisma.gradingSystem.create({ data: { ...rule, examTypeId: et.id } });
    }
  }
  console.log('  grading ready');

  // ---------- 7. Fee structures ----------
  console.log('Seeding fee structures...');
  for (const cls of classes) {
    const low = ['Play Group', 'Nursery', 'Kindergarten'].includes(cls.name);
    const mid = ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5'].includes(cls.name);
    const amount = low ? 1800 : mid ? 2400 : 3000;
    const existing = await prisma.feeStructure.findFirst({ where: { name: `${cls.name} ${cls.section} Tuition` } });
    if (!existing) {
      await prisma.feeStructure.create({
        data: { name: `${cls.name} ${cls.section} Tuition`, classId: cls.id, amount, frequency: 'monthly', isActive: true },
      });
    }
  }
  console.log('  fee structures ready');

  // ---------- 8. Invoices, payments, ledger ----------
  console.log('Seeding invoices + ledger...');
  const students = await prisma.student.findMany({ orderBy: { admissionNo: 'asc' } });
  const packageByClass = new Map<string, any>();
  for (const cls of classes) {
    const pkg = await prisma.admissionPackage.findFirst({ where: { classId: cls.id }, include: { feeItems: true } });
    if (pkg) packageByClass.set(`${cls.name}|${cls.section}`, pkg);
  }

  for (let i = 0; i < students.length; i++) {
    const s = students[i];
    const idx = i % 3; // 0 paid, 1 partial, 2 unpaid
    const pkg = packageByClass.get(`${s.class}|${s.section}`);
    const monthlyTuition = pkg?.feeItems.find((f: any) => f.name.includes('Tuition'))?.amount || 2400;

    const existing = await prisma.invoice.findFirst({
      where: { studentId: s.id, type: 'tuition', billingMonth: BILLING_MONTH },
    });
    if (existing) continue;

    let paidAmount = 0;
    if (idx === 0) paidAmount = monthlyTuition;
    else if (idx === 1) paidAmount = Math.round(monthlyTuition * 0.5);

    const invoice = await prisma.invoice.create({
      data: {
        studentId: s.id,
        type: 'tuition',
        totalAmount: monthlyTuition,
        paidAmount,
        status: paidAmount >= monthlyTuition ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid',
        billingMonth: BILLING_MONTH,
        dueDate: new Date(CURRENT_YEAR, CURRENT_MONTH - 1, 10),
        items: { create: [{ name: `Monthly Tuition - ${BILLING_MONTH}`, amount: monthlyTuition }] },
      },
    });

    if (paidAmount > 0) {
      await prisma.payment.create({
        data: {
          invoiceId: invoice.id,
          amount: paidAmount,
          method: 'Cash',
          transactionRef: `TXN-${s.admissionNo}`,
          receivedBy: 'Admin',
          date: new Date(CURRENT_YEAR, CURRENT_MONTH - 1, 1 + Math.floor(Math.random() * 9)),
        },
      });
      await prisma.ledgerEntry.create({
        data: {
          type: 'income',
          category: 'fee_collection',
          amount: paidAmount,
          referenceInvoice: invoice.id,
          createdAt: new Date(CURRENT_YEAR, CURRENT_MONTH - 1, 1 + Math.floor(Math.random() * 9)),
        },
      });
    }
  }

  // Admission invoices (paid) for first student of each class
  for (const cls of classes) {
    const firstStudent = students.find((s) => s.class === cls.name && s.section === cls.section);
    if (!firstStudent) continue;
    const pkg = packageByClass.get(`${cls.name}|${cls.section}`);
    if (!pkg) continue;
    const total = pkg.feeItems.reduce((sum, f: any) => sum.plus(f.amount), new Prisma.Decimal(0));
    const existing = await prisma.invoice.findFirst({ where: { studentId: firstStudent.id, type: 'admission' } });
    if (existing) continue;
    const invoice = await prisma.invoice.create({
      data: {
        studentId: firstStudent.id,
        type: 'admission',
        totalAmount: total,
        paidAmount: total,
        status: 'paid',
        items: { create: pkg.feeItems.map((f: any) => ({ name: f.name, amount: f.amount })) },
      },
    });
    await prisma.payment.create({
      data: { invoiceId: invoice.id, amount: total, method: 'Cash', transactionRef: `ADM-${firstStudent.admissionNo}`, receivedBy: 'Admin' },
    });
    await prisma.ledgerEntry.create({
      data: { type: 'income', category: 'admission_fee', amount: total, referenceInvoice: invoice.id },
    });
  }
  console.log('  invoices ready');

  // ---------- 9. Salaries + staff ----------
  console.log('Seeding salaries + staff...');
  for (const st of STAFF) {
    await prisma.staff.upsert({ where: { employeeId: st.employeeId }, update: {}, create: st });
  }
  for (let i = 0; i < 6; i++) {
    const t = teachers[i];
    const payDate = new Date(CURRENT_YEAR, CURRENT_MONTH - 1, 28);
    const existing = await prisma.teacherSalary.findFirst({ where: { teacherId: t.id, paymentDate: payDate } });
    if (existing) continue;
    const salary = t.salary || 15000;
    await prisma.teacherSalary.create({
      data: {
        teacherId: t.id,
        baseSalary: salary,
        bonus: Math.round(salary * 0.05),
        deductions: Math.round(salary * 0.02),
        netSalary: Math.round(salary * 1.03),
        paymentDate: payDate,
        status: 'Paid',
      },
    });
    await prisma.ledgerEntry.create({
      data: { type: 'expense', category: 'teacher_salary', amount: Math.round(salary * 1.03), createdAt: payDate },
    });
  }
  console.log('  salaries ready');

  // ---------- 10. Attendance for today ----------
  console.log('Seeding attendance...');
  const grade1a = students.filter((s) => s.class === 'Grade 1' && s.section === 'A');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const s of grade1a) {
    const status = s.roll % 5 === 0 ? 'Absent' : s.roll % 4 === 0 ? 'Late' : 'Present';
    await prisma.attendance.upsert({
      where: { studentId_date: { studentId: s.id, date: today } },
      update: { status },
      create: { studentId: s.id, date: today, status },
    });
  }
  console.log(`  attendance for ${grade1a.length} students`);

  // ---------- 11. Exams + schedules + results ----------
  console.log('Seeding exams + results...');
  const firstTerm = examTypes[0];
  const mathSubject = await prisma.subject.findUnique({ where: { code: 'MATH' } });
  const engSubject = await prisma.subject.findUnique({ where: { code: 'ENG' } });
  const banSubject = await prisma.subject.findUnique({ where: { code: 'BAN' } });

  let exam = await prisma.exam.findFirst({ where: { name: `First Term ${CURRENT_YEAR}`, typeId: firstTerm.id } });
  if (!exam) {
    exam = await prisma.exam.create({
      data: {
        name: `First Term ${CURRENT_YEAR}`,
        typeId: firstTerm.id,
        startDate: new Date(CURRENT_YEAR, CURRENT_MONTH - 2, 1),
        endDate: new Date(CURRENT_YEAR, CURRENT_MONTH - 2, 15),
        academicYear: `${CURRENT_YEAR}-${CURRENT_YEAR + 1}`,
      },
    });
  }

  for (const cls of classes.filter((c) => c.name === 'Grade 1' || c.name === 'Grade 5')) {
    const clsRecord = await prisma.schoolClass.findFirst({ where: { name: cls.name, section: cls.section } });
    if (!clsRecord) continue;
    for (const subj of [mathSubject, engSubject, banSubject]) {
      if (!subj) continue;
      const sched = await prisma.examSchedule.upsert({
        where: { examId_subjectId_classId: { examId: exam.id, subjectId: subj.id, classId: clsRecord.id } },
        update: {},
        create: {
          examId: exam.id,
          subjectId: subj.id,
          classId: clsRecord.id,
          date: new Date(CURRENT_YEAR, CURRENT_MONTH - 2, 2 + (subj.code === 'MATH' ? 0 : subj.code === 'ENG' ? 2 : 4)),
          startTime: '09:00',
          endTime: '11:00',
          fullMarks: 100,
          passMarks: 40,
          roomNo: `R-${100 + (subj.code === 'MATH' ? 1 : subj.code === 'ENG' ? 2 : 3)}`,
        },
      });
      void sched;
    }
    const classStudents = students.filter((s) => s.class === cls.name && s.section === cls.section).slice(0, 5);
    for (const s of classStudents) {
      for (const subj of [mathSubject, engSubject, banSubject]) {
        if (!subj) continue;
        const rand = rng(s.admissionNo.length * 7 + subj.code.length);
        const written = Math.round(20 + rand() * 55);
        const mcq = Math.round(5 + rand() * 20);
        const practical = Math.round(3 + rand() * 15);
        const total = written + mcq + practical;
        const percent = total;
        const g = gradeFor(percent);
        const existingRes = await prisma.result.findUnique({
          where: { studentId_examId_subjectId: { studentId: s.id, examId: exam.id, subjectId: subj.id } },
        });
        if (existingRes) continue;
        await prisma.result.create({
          data: {
            studentId: s.id,
            examId: exam.id,
            subjectId: subj.id,
            written,
            mcq,
            practical,
            totalMarks: total,
            grade: g.grade,
            gp: g.gp,
            highestMarks: 92,
          },
        });
      }
    }
  }
  console.log('  exams ready');

  // ---------- 12. Institute profile ----------
  console.log('Seeding institute profile...');
  await prisma.institute.upsert({
    where: { email: 'admin@academify.com' },
    update: {},
    create: {
      name: 'Academify International School',
      targetLine: 'Excellence in Education',
      email: 'admin@academify.com',
      phone: '+8801700000000',
      website: 'https://school-management-system-vkqo.vercel.app',
      address: '12, Dhanmondi, Dhaka',
      country: 'Bangladesh',
      currency: 'USD',
    },
  });

  console.log('\n======== SEED COMPLETE ========');
  console.log(`Classes: ${classes.length}`);
  console.log(`Subjects: ${SUBJECTS.length}`);
  console.log(`Teachers: ${teachers.length}`);
  console.log(`Students: ${studentCount}`);
  console.log(`Staff: ${STAFF.length}`);
  console.log('\nLogins:');
  console.log('  Admin  : admin@academify.com / fresh_password_2026');
  console.log('  Teacher: <teacher email> / password  (e.g. rahim.uddin@academify.edu / password)');
  console.log('  Student: <admissionNo> / password   (e.g. ADM-2026-0001 / password)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
