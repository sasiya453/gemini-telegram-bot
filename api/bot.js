import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// --- ENVIRONMENT VARIABLES ---
// Set these in Vercel Dashboard → Settings → Environment Variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;          // e.g. 12345:ABC...
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const CHANNEL_USERNAME = process.env.TELEGRAM_CHANNEL_USERNAME; // e.g. @YourChannel
const CHANNEL_URL = process.env.TELEGRAM_CHANNEL_URL;           // e.g. https://t.me/YourChannel

const WEBAPP_URL = process.env.WEBAPP_URL;                      // registration / main mini-app
const HELP_URL = process.env.HELP_URL || 'https://t.me/your_help_link';
const TOP10_WEBAPP_URL = process.env.TOP10_WEBAPP_URL || WEBAPP_URL; // leaderboard mini-app

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;     // or anon if RLS disabled

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- BASIC TELEGRAM HELPERS ----
async function callTelegram(method, params) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) console.error('Telegram error', method, data);
  return data;
}

// Send a new menu or edit the existing one (single-message menus)
async function sendOrEditMenu({ chatId, messageId, text, keyboard }) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard },
  };

  if (messageId) {
    return callTelegram('editMessageText', {
      ...payload,
      message_id: messageId,
    });
  }

  return callTelegram('sendMessage', payload);
}

async function isMemberOfChannel(userId) {
  if (!CHANNEL_USERNAME) return true; // skip check if not set

  try {
    const res = await fetch(
      `${TELEGRAM_API}/getChatMember?chat_id=${encodeURIComponent(
        CHANNEL_USERNAME
      )}&user_id=${userId}`
    );
    const data = await res.json();
    if (!data.ok) {
      console.error('getChatMember error', data);
      return false;
    }
    const status = data.result.status;
    return (
      status === 'member' ||
      status === 'administrator' ||
      status === 'creator'
    );
  } catch (e) {
    console.error('isMemberOfChannel error', e);
    return false;
  }
}

// ---- SUPABASE HELPERS ----
async function isRegistered(telegramId) {
  const { data, error } = await supabase
    .from('students')
    .select('id, stream, grade, full_name')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  if (error) {
    console.error('isRegistered error', error);
    return null;
  }
  return data; // null if not found
}

async function getSession(telegramId) {
  const { data, error } = await supabase
    .from('bot_sessions')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  if (error || !data) {
    return { telegram_id: telegramId, state: 'IDLE', data: {} };
  }
  return data;
}

async function saveSession(session) {
  const { error } = await supabase.from('bot_sessions').upsert({
    telegram_id: session.telegram_id,
    state: session.state,
    data: session.data,
    updated_at: new Date().toISOString(),
  });
  if (error) console.error('saveSession error', error);
}

// ---- TEXT WRAP + PDF GENERATION ----
function wrapText(text, maxChars = 100) {
  if (!text) return [];
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars) {
      lines.push(line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function answerLabel(idx) {
  return ['A', 'B', 'C', 'D'][idx - 1] || '?';
}

async function createPdfForSession(session, questionsById) {
  const pdfDoc = await PDFDocument.create();
  let page = pdfDoc.addPage();
  const width = page.getWidth();
  const height = page.getHeight();
  const margin = 40;
  let y = height - margin;

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  function addPage() {
    page = pdfDoc.addPage();
    y = height - margin;
  }

  function drawLines(text, { bold = false, size = 11 } = {}) {
    const fontUsed = bold ? boldFont : font;
    const lines = wrapText(text, 100);
    for (const line of lines) {
      if (y < margin) addPage();
      page.drawText(line, { x: margin, y, size, font: fontUsed });
      y -= size + 2;
    }
  }

  const { qcount, score } = session.data;

  drawLines('A/L MCQ Practice Session', { bold: true, size: 16 });
  y -= 4;
  drawLines(`Score: ${score}/${qcount}`, { bold: true });
  y -= 8;

  session.data.answers.forEach((ans, idx) => {
    const q = questionsById.get(ans.question_id);
    if (!q) return;

    if (y < margin + 60) addPage();

    drawLines(`Q${idx + 1}. ${q.question}`, { bold: true });
    drawLines(`A) ${q.answer_1}`);
    drawLines(`B) ${q.answer_2}`);
    drawLines(`C) ${q.answer_3}`);
    drawLines(`D) ${q.answer_4}`);
    drawLines(
      `Your answer: ${answerLabel(ans.chosen_answer)}   |   Correct: ${answerLabel(
        ans.correct_answer
      )}`,
      { size: 10 }
    );
    if (q.explanation) {
      drawLines(`Explanation: ${q.explanation}`, { size: 10 });
    }
    y -= 8;
  });

  const pdfBytes = await pdfDoc.save();
  return pdfBytes; // Uint8Array
}

async function handleGetPdf(chatId, userId) {
  const session = await getSession(userId);

  if (!session || !session.data || !session.data.answers || session.data.answers.length === 0) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: 'No finished practice session found to create a PDF.',
    });
    return;
  }

  const questionIds = session.data.answers.map((a) => a.question_id);
  const { data: questions, error } = await supabase
    .from('practice_questions')
    .select('*')
    .in('id', questionIds);

  if (error || !questions) {
    console.error('PDF questions fetch error', error);
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: 'Failed to load questions for PDF.',
    });
    return;
  }

  const questionsById = new Map(questions.map((q) => [q.id, q]));
  const pdfBytes = await createPdfForSession(session, questionsById);

  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  formData.append(
    'document',
    new Blob([pdfBytes], { type: 'application/pdf' }),
    'al_mcq_session.pdf'
  );

  await fetch(`${TELEGRAM_API}/sendDocument`, {
    method: 'POST',
    body: formData,
  });
}

// ---- MAIN GATEKEEPER FLOW ----
async function handleStart(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // 1) Force-subscribe to channel
  const member = await isMemberOfChannel(userId);
  if (!member) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text:
        '📢 Please join our channel before using the A/L MCQ bot.\n\n' +
        'After joining, tap "Done & Start".',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📲 Join Channel', url: CHANNEL_URL }],
          [{ text: '✅ Done & Start', callback_data: 'done_join' }],
        ],
      },
    });
    return;
  }

  // 2) Registration check
  const studentRow = await isRegistered(userId);
  if (!studentRow) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text:
        '👋 Welcome to A/L MCQ Bot.\n\n' +
        'You are *not registered* yet. Please sign up using the Web App.',
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '📝 Register / Login',
              web_app: { url: WEBAPP_URL },
            },
          ],
          [{ text: '❓ Help', url: HELP_URL }],
          [{ text: '✅ I have registered', callback_data: 'check_registered' }],
        ],
      },
    });
    return;
  }

  // 3) Registered → Main menu (new message first time)
  await showMainMenu(chatId, userId, studentRow, null);
}

async function showMainMenu(chatId, userId, studentRow, messageId = null) {
  const name = studentRow?.full_name || 'Student';

  await saveSession({
    telegram_id: userId,
    state: 'IDLE',
    data: { student_id: studentRow?.id || null },
  });

  await sendOrEditMenu({
    chatId,
    messageId,
    text:
      `👋 Hi *${name}*!\n` +
      'Welcome to the A/L MCQ practice bot.\n\n' +
      'Choose an option:',
    keyboard: [
      [{ text: '📚 Practice MCQs', callback_data: 'menu_practice' }],
      [{ text: '🏆 Weekly Paper', callback_data: 'menu_weekly' }],
      [{ text: 'ℹ️ About Us', callback_data: 'menu_about' }],
    ],
  });
}

// ---- PRACTICE FLOW ----
async function handlePracticeMenu(chatId, userId, messageId = null) {
  const session = await getSession(userId);
  session.state = 'CHOOSING_SUBJECT';
  session.data = session.data || {};
  await saveSession(session);

  await sendOrEditMenu({
    chatId,
    messageId,
    text: '📚 *Practice MCQs*\nSelect a subject:',
    keyboard: [
      [
        { text: 'Physics', callback_data: 'practice_subject_1' },
        { text: 'Chemistry', callback_data: 'practice_subject_2' },
      ],
      [
        { text: 'Bio', callback_data: 'practice_subject_3' },
        { text: 'Maths', callback_data: 'practice_subject_4' },
      ],
      [{ text: '⬅️ Main Menu', callback_data: 'goto_main_menu' }],
    ],
  });
}

function subjectLabel(id) {
  return { 1: 'Physics', 2: 'Chemistry', 3: 'Bio', 4: 'Maths' }[id] || 'Subject';
}

async function handleSubjectChosen(chatId, userId, subjectId, messageId = null) {
  const session = await getSession(userId);
  session.state = 'CHOOSING_TYPE';
  session.data = { ...session.data, subjectId, practiceType: null, lesson: null, term: null };
  await saveSession(session);

  await sendOrEditMenu({
    chatId,
    messageId,
    text:
      `*${subjectLabel(subjectId)}* selected.\n` +
      'What do you want to practice?',
    keyboard: [
      [{ text: 'Lesson target MCQs', callback_data: 'practice_type_lesson' }],
      [{ text: 'A/L exam target MCQs', callback_data: 'practice_type_exam' }],
      [{ text: 'Term test target MCQs', callback_data: 'practice_type_term' }],
      [{ text: '⬅️ Back to subjects', callback_data: 'menu_practice' }],
    ],
  });
}

// ---- LESSON / TERM LISTS ----
async function sendLessonChooser(chatId, session, messageId = null) {
  const subjectId = session.data.subjectId;

  const { data, error } = await supabase
    .from('practice_questions')
    .select('lesson')
    .eq('subject_id', subjectId)
    .not('lesson', 'is', null)
    .order('lesson', { ascending: true });

  if (error || !data || data.length === 0) {
    await sendOrEditMenu({
      chatId,
      messageId,
      text: 'No lessons found for this subject.',
      keyboard: [[{ text: '⬅️ Back', callback_data: 'menu_practice' }]],
    });
    return;
  }

  const lessons = [...new Set(data.map((r) => r.lesson))].sort((a, b) => a - b);

  const rows = [];
  for (let i = 0; i < lessons.length; i += 2) {
    const row = [];
    row.push({
      text: `Lesson ${lessons[i]}`,
      callback_data: `practice_lesson_${lessons[i]}`,
    });
    if (lessons[i + 1]) {
      row.push({
        text: `Lesson ${lessons[i + 1]}`,
        callback_data: `practice_lesson_${lessons[i + 1]}`,
      });
    }
    rows.push(row);
  }
  rows.push([{ text: '⬅️ Back', callback_data: 'menu_practice' }]);

  await sendOrEditMenu({
    chatId,
    messageId,
    text: 'Select a lesson:',
    keyboard: rows,
  });
}

async function sendTermChooser(chatId, session, messageId = null) {
  const subjectId = session.data.subjectId;

  const { data, error } = await supabase
    .from('practice_questions')
    .select('term')
    .eq('subject_id', subjectId)
    .not('term', 'is', null);

  if (error || !data || data.length === 0) {
    await sendOrEditMenu({
      chatId,
      messageId,
      text: 'No terms found for this subject.',
      keyboard: [[{ text: '⬅️ Back', callback_data: 'menu_practice' }]],
    });
    return;
  }

  const terms = [...new Set(data.map((r) => r.term))].sort();

  const rows = [];
  terms.forEach((term) => {
    const encoded = encodeURIComponent(term);
    rows.push([
      {
        text: term,
        callback_data: `practice_term_${encoded}`,
      },
    ]);
  });
  rows.push([{ text: '⬅️ Back', callback_data: 'menu_practice' }]);

  await sendOrEditMenu({
    chatId,
    messageId,
    text: 'Select a term:',
    keyboard: rows,
  });
}

async function sendQuestionCountChooser(chatId, session, messageId = null) {
  session.state = 'CHOOSING_QCOUNT';
  await saveSession(session);

  await sendOrEditMenu({
    chatId,
    messageId,
    text: 'How many questions?',
    keyboard: [
      [
        { text: '10', callback_data: 'practice_qcount_10' },
        { text: '20', callback_data: 'practice_qcount_20' },
        { text: '30', callback_data: 'practice_qcount_30' },
      ],
      [
        { text: '40', callback_data: 'practice_qcount_40' },
        { text: '50', callback_data: 'practice_qcount_50' },
      ],
      [{ text: '⬅️ Back', callback_data: 'menu_practice' }],
    ],
  });
}

// ---- START PRACTICE QUIZ ----
async function startPracticeQuiz(chatId, userId, qcount) {
  let session = await getSession(userId);
  const { subjectId, practiceType, lesson, term } = session.data;

  let query = supabase
    .from('practice_questions')
    .select('*')
    .eq('subject_id', subjectId);

  if (practiceType === 'lesson') {
    query = query.eq('lesson', lesson);
  } else if (practiceType === 'term') {
    query = query.eq('term', term);
  } else if (practiceType === 'exam') {
    query = query.eq('is_exam_target', true);
  }

  const { data, error } = await query;
  if (error || !data || data.length === 0) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: 'No questions found for this selection.',
    });
    return;
  }

  // Shuffle
  const shuffled = [...data];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const questions = shuffled.slice(0, qcount);

  session.state = 'QUIZ_ACTIVE';
  session.data = {
    ...session.data,
    mode: 'practice',
    qcount,
    questions,
    currentIndex: 0,
    score: 0,
    answers: [],
    startedAt: Date.now(),
  };
  await saveSession(session);

  await sendCurrentQuestion(chatId, session);
}

async function sendCurrentQuestion(chatId, session) {
  const { questions, currentIndex, qcount, subjectId } = session.data;
  const q = questions[currentIndex];

  const text =
    `*Q${currentIndex + 1}/${qcount} - ${subjectLabel(subjectId)}*\n\n` +
    `${q.question}\n\n` +
    `A) ${q.answer_1}\n` +
    `B) ${q.answer_2}\n` +
    `C) ${q.answer_3}\n` +
    `D) ${q.answer_4}`;

  await callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'A', callback_data: 'quiz_answer_1' },
          { text: 'B', callback_data: 'quiz_answer_2' },
        ],
        [
          { text: 'C', callback_data: 'quiz_answer_3' },
          { text: 'D', callback_data: 'quiz_answer_4' },
        ],
        [{ text: '🏳️ Give Up', callback_data: 'quiz_giveup' }],
      ],
    },
  });
}

async function handleQuizAnswer(callbackQuery, chosenIndex) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  let session = await getSession(userId);
  if (session.state !== 'QUIZ_ACTIVE') return;

  const data = session.data;
  const { questions, currentIndex } = data;
  const q = questions[currentIndex];

  const correct = q.correct_answer;
  const isCorrect = correct === chosenIndex;

  data.score = (data.score || 0) + (isCorrect ? 1 : 0);
  data.answers.push({
    question_id: q.id,
    chosen_answer: chosenIndex,
    correct_answer: correct,
    is_correct: isCorrect,
  });

  const resultText =
    `*Q${currentIndex + 1}:* ${q.question}\n\n` +
    `✅ Correct answer: *${answerLabel(correct)}*\n` +
    `📝 Your answer: *${answerLabel(chosenIndex)}*\n\n` +
    (q.explanation ? `*Explanation:* ${q.explanation}` : '');

  await callTelegram('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: resultText,
    parse_mode: 'Markdown',
  });

  // Next or finish?
  if (currentIndex + 1 >= data.qcount) {
    // Finished
    session.state = 'QUIZ_FINISHED';
    await saveSession(session);
    await sendPracticeResult(chatId, session);
  } else {
    data.currentIndex += 1;
    await saveSession(session);
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: 'Next question ➡️',
      reply_markup: {
        inline_keyboard: [[{ text: '➡️ Next', callback_data: 'quiz_next' }]],
      },
    });
  }
}

async function handleQuizNext(chatId, userId, nextMsgId) {
  // delete the "Next" message
  if (nextMsgId) {
    await callTelegram('deleteMessage', {
      chat_id: chatId,
      message_id: nextMsgId,
    });
  }
  const session = await getSession(userId);
  if (session.state !== 'QUIZ_ACTIVE') return;
  await sendCurrentQuestion(chatId, session);
}

async function handleQuizGiveUp(chatId, userId) {
  let session = await getSession(userId);
  if (session.state !== 'QUIZ_ACTIVE') return;

  session.state = 'QUIZ_FINISHED';
  await saveSession(session);
  await sendPracticeResult(chatId, session, { gaveUp: true });
}

async function sendPracticeResult(chatId, session, opts = {}) {
  const { qcount, score } = session.data;
  const gaveUp = opts.gaveUp;

  const text =
    `📊 *Practice session finished*\n\n` +
    `Score: *${score}/${qcount}*\n` +
    (gaveUp ? '_You ended the quiz early._\n\n' : '\n') +
    'Tap *Get PDF here* to download this session as a PDF.';

  await callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📄 Get PDF here', callback_data: 'get_pdf' }],
        [
          {
            text: '🌐 Open Web App (Analytics)',
            web_app: { url: WEBAPP_URL },
          },
        ],
        [{ text: '🏠 Main Menu', callback_data: 'goto_main_menu' }],
      ],
    },
  });

  // Optional: store results into practice_sessions table (simplified)
  try {
    const studentRow = await isRegistered(session.telegram_id);
    const correct = score;
    const total = qcount;
    const now = new Date();

    await supabase.from('practice_sessions').insert({
      student_id: studentRow?.id || null,
      telegram_id: session.telegram_id,
      subject_id: session.data.subjectId,
      practice_type: session.data.practiceType,
      lesson: session.data.lesson,
      term: session.data.term,
      question_count: total,
      correct_count: correct,
      total_time_ms: null,
      avg_time_ms: null,
      started_at: now.toISOString(),
      finished_at: now.toISOString(),
    });
  } catch (e) {
    console.error('Error saving practice session', e);
  }
}

// ---- WEEKLY PAPER (Top 10 opens WebApp) ----
async function handleWeeklyMenu(chatId, messageId = null) {
  await sendOrEditMenu({
    chatId,
    messageId,
    text: '🏆 *Weekly Paper*\nChoose your stream:',
    keyboard: [
      [
        { text: 'Bio Stream', callback_data: 'weekly_stream_bio' },
        { text: 'Maths Stream', callback_data: 'weekly_stream_maths' },
      ],
      [{ text: '⬅️ Main Menu', callback_data: 'goto_main_menu' }],
    ],
  });
}

async function handleWeeklyStream(chatId, stream, messageId = null) {
  const streamLabel = stream === 'bio' ? 'Bio Stream' : 'Maths Stream';

  await sendOrEditMenu({
    chatId,
    messageId,
    text:
      `🏆 *Weekly Paper – ${streamLabel}*\n\n` +
      'Attend the paper via bot (soon) and see Top 10 in the Web App.',
    keyboard: [
      [{ text: '✏️ Attend Paper (soon)', callback_data: 'noop' }],
      [
        {
          text: '🏅 View Top 10',
          web_app: { url: `${TOP10_WEBAPP_URL}?stream=${stream}` },
        },
      ],
      [{ text: '⬅️ Back', callback_data: 'menu_weekly' }],
    ],
  });
}

// ---- ABOUT ----
async function handleAbout(chatId, messageId = null) {
  await sendOrEditMenu({
    chatId,
    messageId,
    text:
      'ℹ️ *About Us*\n\n' +
      'This bot helps A/L students practice MCQs in Physics, Chemistry, Bio and Maths.\n' +
      '• Lesson, term and exam‑target practice\n' +
      '• Weekly mixed papers with rankings\n' +
      '• Detailed analytics and PDFs in the Web App.',
    keyboard: [[{ text: '⬅️ Main Menu', callback_data: 'goto_main_menu' }]],
  });
}

// ---- MESSAGE HANDLER ----
async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = (message.text || '').trim();

  if (text.toLowerCase().startsWith('/start')) {
    await handleStart(message);
    return;
  }

  await callTelegram('sendMessage', {
    chat_id: chatId,
    text: 'Use /start to open the main menu.',
  });
}

// ---- CALLBACK HANDLER ----
async function handleCallback(callbackQuery) {
  const { data } = callbackQuery;
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const messageId = callbackQuery.message.message_id;

  // Acknowledge callback to remove "loading" state
  await callTelegram('answerCallbackQuery', {
    callback_query_id: callbackQuery.id,
  });

  if (data === 'done_join') {
    await handleStart({ chat: { id: chatId }, from: { id: userId } });
    return;
  }

  if (data === 'check_registered') {
    const studentRow = await isRegistered(userId);
    if (!studentRow) {
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text:
          'Still not registered.\n\nPlease open the Web App, finish registration, then tap "I have registered" again.',
      });
      return;
    }
    await showMainMenu(chatId, userId, studentRow, messageId);
    return;
  }

  if (data === 'goto_main_menu') {
    const studentRow = await isRegistered(userId);
    await showMainMenu(chatId, userId, studentRow || {}, messageId);
    return;
  }

  if (data === 'menu_practice') {
    await handlePracticeMenu(chatId, userId, messageId);
    return;
  }

  if (data === 'menu_weekly') {
    await handleWeeklyMenu(chatId, messageId);
    return;
  }

  if (data === 'menu_about') {
    await handleAbout(chatId, messageId);
    return;
  }

  if (data.startsWith('practice_subject_')) {
    const id = parseInt(data.split('_').pop(), 10);
    await handleSubjectChosen(chatId, userId, id, messageId);
    return;
  }

  if (
    data === 'practice_type_lesson' ||
    data === 'practice_type_term' ||
    data === 'practice_type_exam'
  ) {
    const session = await getSession(userId);
    session.data.practiceType =
      data === 'practice_type_lesson'
        ? 'lesson'
        : data === 'practice_type_term'
        ? 'term'
        : 'exam';
    await saveSession(session);

    if (session.data.practiceType === 'lesson') {
      await sendLessonChooser(chatId, session, messageId);
    } else if (session.data.practiceType === 'term') {
      await sendTermChooser(chatId, session, messageId);
    } else {
      await sendQuestionCountChooser(chatId, session, messageId);
    }
    return;
  }

  if (data.startsWith('practice_lesson_')) {
    const lesson = parseInt(data.split('_').pop(), 10);
    const session = await getSession(userId);
    session.data.lesson = lesson;
    await saveSession(session);
    await sendQuestionCountChooser(chatId, session, messageId);
    return;
  }

  if (data.startsWith('practice_term_')) {
    const encoded = data.replace('practice_term_', '');
    const term = decodeURIComponent(encoded);
    const session = await getSession(userId);
    session.data.term = term;
    await saveSession(session);
    await sendQuestionCountChooser(chatId, session, messageId);
    return;
  }

  if (data.startsWith('practice_qcount_')) {
    const qcount = parseInt(data.split('_').pop(), 10);

    // delete the question-count menu before starting quiz
    await callTelegram('deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    });

    await startPracticeQuiz(chatId, userId, qcount);
    return;
  }

  if (data.startsWith('quiz_answer_')) {
    const idx = parseInt(data.split('_').pop(), 10);
    await handleQuizAnswer(callbackQuery, idx);
    return;
  }

  if (data === 'quiz_next') {
    await handleQuizNext(chatId, userId, messageId);
    return;
  }

  if (data === 'quiz_giveup') {
    await handleQuizGiveUp(chatId, userId);
    return;
  }

  if (data === 'weekly_stream_bio') {
    await handleWeeklyStream(chatId, 'bio', messageId);
    return;
  }
  if (data === 'weekly_stream_maths') {
    await handleWeeklyStream(chatId, 'maths', messageId);
    return;
  }

  if (data === 'get_pdf') {
    await handleGetPdf(chatId, userId);
    return;
  }

  if (data === 'noop') return;
}

// ---- VERCEL HANDLER ----
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('OK');
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const update = req.body;

  try {
    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }
  } catch (err) {
    console.error('Update handling error', err);
  }

  return res.status(200).json({ ok: true });
}
