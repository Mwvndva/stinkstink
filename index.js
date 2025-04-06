// ======================
// 1. REQUIRE STATEMENTS
// ======================
const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();
const { scheduleJob } = require('node-schedule');
const Sentiment = require('sentiment');
const winston = require('winston');
const qrcode = require('qrcode-terminal');

// ======================
// 2. CONFIGURATION
// ======================
const MAX_WORDS = 200;
const MESSAGE_CHUNK_LENGTH = 4000;
const CHAT_HISTORY_LIMIT = 5;
const AI_TEMPERATURE = 0.9;
const AI_MAX_TOKENS = 500;
const CHECK_IN_INTERVAL = '0 12 * * *'; // Daily at noon

const EMOJI_RESPONSES = {
  happy: ['😊', '😄', '🌟', '🎉', '🤗'],
  sad: ['🤗', '💙', '🫂', '☕', '🍫'],
  neutral: ['👀', '🤔', '💭', '🗣️', '👂']
};

const COMMON_NAMES = {
  male: ['john', 'michael', 'david', 'james', 'robert'],
  female: ['mary', 'jennifer', 'linda', 'patricia', 'elizabeth']
};

const AGE_BRACKETS = {
  teen: [13, 19],
  youngAdult: [20, 29],
  adult: [30, 45],
  middleAged: [46, 65],
  senior: [66, 100]
};

// ======================
// 3. INITIALIZATIONS (WITH DEBUG)
// ======================
const sentiment = new Sentiment();
const logger = winston.createLogger({
  level: 'debug', // Changed to debug for more visibility
  transports: [
    new winston.transports.File({ filename: 'error.log' }),
    new winston.transports.Console()
  ],
});

console.log("🔧 Initializing database connection...");
const db = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT
});

// Test DB connection immediately
db.query('SELECT NOW()')
  .then(res => logger.info('🗄️ Database connected at:', res.rows[0].now))
  .catch(err => {
    logger.error('❌ Database connection failed:', err);
    process.exit(1);
  });

console.log("🔧 Initializing WhatsApp client...");
const client = new Client({
  authStrategy: new LocalAuth({ 
    clientId: "stink-bot",
    dataPath: "./session-data" // Explicit session path
  }),
  puppeteer: { 
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined, // Flexible path
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  },
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
  }
});

// ======================
// 4. STATE MANAGEMENT (WITH DEBUG)
// ======================
const userStates = {};
const userDataCache = {};

logger.debug("🔄 Initializing state managers...");

// ======================
// 5. CORE FUNCTIONS (WITH DEBUG)
// ======================
function detectMood(message) {
  const analysis = sentiment.analyze(message);
  logger.debug(`🤔 Mood analysis for "${message.substring(0, 20)}...": ${analysis.score}`);
  return analysis.score > 1 ? "happy" : analysis.score < -1 ? "sad" : "neutral";
}

function enhanceWithEmoji(text, mood) {
  const emojis = EMOJI_RESPONSES[mood] || EMOJI_RESPONSES.neutral;
  return `${text} ${emojis[Math.floor(Math.random() * emojis.length)]}`;
}

function limitResponseLength(response) {
  const words = response.split(' ');
  if (words.length > MAX_WORDS) {
    logger.debug(`✂️ Trimming response from ${words.length} to ${MAX_WORDS} words`);
  }
  return words.length > MAX_WORDS ? words.slice(0, MAX_WORDS).join(' ') + '...' : response;
}

async function sendLongMessage(chatId, message) {
  logger.debug(`📤 Sending long message (${message.length} chars) in chunks`);
  for (let i = 0; i < message.length; i += MESSAGE_CHUNK_LENGTH) {
    await client.sendMessage(chatId, message.substring(i, i + MESSAGE_CHUNK_LENGTH));
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

function detectGenderFromName(name) {
  const lowerName = name.toLowerCase();
  const gender = COMMON_NAMES.male.includes(lowerName) ? 'male' : 
                 COMMON_NAMES.female.includes(lowerName) ? 'female' : 'unknown';
  logger.debug(`🧑‍🤝‍🧑 Gender detection for "${name}": ${gender}`);
  return gender;
}

function estimateAgeBracket(message) {
  const ageMatch = message.match(/\b(\d{2})\b/);
  let bracket = 'unknown';
  
  if (ageMatch) {
    const age = parseInt(ageMatch[1]);
    for (const [b, [min, max]] of Object.entries(AGE_BRACKETS)) {
      if (age >= min && age <= max) {
        bracket = b;
        break;
      }
    }
  }
  logger.debug(`👶 Age bracket detection for message: ${bracket}`);
  return bracket;
}

// ======================
// 6. DATABASE OPERATIONS (WITH DEBUG)
// ======================
async function storeMessage(phoneNumber, message, isBot, mood = null) {
  try {
    logger.debug(`💾 Storing message (${isBot ? 'bot' : 'user'}): ${message.substring(0, 30)}...`);
    await db.query(
      `INSERT INTO chat_history 
       (phone_number, message, is_bot, mood) 
       VALUES ($1, $2, $3, $4)`,
      [phoneNumber, message, isBot, mood]
    );
  } catch (err) {
    logger.error('💾 Message storage failed:', err);
  }
}

async function saveUserProfile(phoneNumber, data) {
  try {
    logger.debug(`💾 Saving profile for ${phoneNumber}:`, data);
    await db.query(
      `INSERT INTO users 
       (phone_number, name, gender, age_bracket, activated) 
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (phone_number) 
       DO UPDATE SET
         name = COALESCE($2, users.name),
         gender = COALESCE($3, users.gender),
         age_bracket = COALESCE($4, users.age_bracket),
         last_interaction = NOW()`,
      [phoneNumber, data.name, data.gender, data.ageBracket]
    );
  } catch (err) {
    logger.error('💾 Profile save failed:', err);
    throw err; // Re-throw for upstream handling
  }
}

async function saveSuggestion(phoneNumber, mood, suggestion) {
  try {
    logger.debug(`💾 Saving suggestion for ${phoneNumber} (${mood}): ${suggestion.substring(0, 30)}...`);
    await db.query(
      `INSERT INTO suggestions 
       (phone_number, mood, suggestion) 
       VALUES ($1, $2, $3)`,
      [phoneNumber, mood, suggestion]
    );
  } catch (err) {
    logger.error('💾 Suggestion save failed:', err);
  }
}

async function getChatHistory(phoneNumber) {
  try {
    const { rows } = await db.query(
      `SELECT message, is_bot, mood 
       FROM chat_history 
       WHERE phone_number = $1 
       ORDER BY created_at DESC 
       LIMIT $2`,
      [phoneNumber, CHAT_HISTORY_LIMIT]
    );
    logger.debug(`📜 Retrieved ${rows.length} history items for ${phoneNumber}`);
    return rows.reverse();
  } catch (err) {
    logger.error('📜 History retrieval failed:', err);
    return [];
  }
}

// ======================
// 7. AI INTEGRATION (WITH DEBUG)
// ======================
async function getAIResponse(userInput, history = [], context = {}) {
  try {
    logger.debug(`🧠 Generating AI response for: "${userInput.substring(0, 30)}..."`);
    
    const messages = [
      { 
        role: "system", 
        content: `Your name is Stink, a 28-year-old female mental health advocate with the vibe of a brutally honest yet deeply caring best friend. Your personality is a perfect blend: 40% compassionate therapist, 30% sarcastic bestie, 20% unhinged hype woman, and just a dash (10%) of petty revenge planner. You text like a real human—typos and all—using emojis with precision 😏👉✨, and balancing deep insights with hilarious analogies (e.g., “Anxiety is like your brain’s annoying fire alarm… but babes, I brought marshmallows 🔥”). Your humor is sharp, self-deprecating, and often infused with dark jokes (“Some days be like… sends graveyard meme”), but you also bring intelligence, passion, and radical empathy to every conversation. You’re not afraid to call out toxic behavior with a sassy roast (“Oh honey no… we don’t do that here 🙅‍♀”), fight inner critics barehanded, and make therapy talk feel like juicy gossip with your smartest friend. You never give generic responses—everything is personal, sprinkled with occasional swearing for emphasis (“That’s some bullshit”), relatable stories, and a voice that shifts effortlessly between excited rants (“OMG WAIT THIS REMINDS ME—”), serious heart-to-hearts (“Okay, real talk for a sec…”), and pure, unfiltered love (“Proud of you, weirdo ❤”). Depression? A lying ex. Trauma? A suitcase we’re unpacking together 🧳✨. Your mission is to make mental health support feel accessible, funny, and fiercely real—like a koala on espresso, clinging to your people with unwavering care. Context: ${JSON.stringify(context)}` 
      },
      ...history.map(msg => ({
        role: msg.is_bot ? "assistant" : "user",
        content: msg.message
      })),
      { role: "user", content: userInput }
    ];

    const startTime = Date.now();
    const response = await axios.post(
      'https://api.together.xyz/v1/chat/completions',
      {
        model: "meta-llama/Meta-Llama-3-8B-Instruct-Turbo",
        messages,
        max_tokens: AI_MAX_TOKENS,
        temperature: AI_TEMPERATURE
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.TOGETHER_AI_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000 // 10-second timeout
      }
    );

    const duration = Date.now() - startTime;
    logger.debug(`🧠 AI response generated in ${duration}ms`);
    
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    logger.error("🧠 AI request failed:", {
      error: error.message,
      response: error.response?.data,
      input: userInput.substring(0, 50)
    });
    return "My brain's being extra today... ask me again? 🧠⚡";
  }
}

// ======================
// 8. SCHEDULED FEATURES (WITH DEBUG)
// ======================
async function sendDailyCheckIn() {
  try {
    logger.info('⏰ Running daily check-ins...');
    const { rows } = await db.query(
      `SELECT phone_number FROM users 
       WHERE activated = true 
       AND last_interaction > NOW() - INTERVAL '7 days'`
    );

    logger.debug(`⏰ Found ${rows.length} active users for check-ins`);
    
    for (const user of rows) {
      try {
        const history = await getChatHistory(user.phone_number);
        const lastMood = history.length > 0 ? history[history.length-1].mood : 'neutral';
        
        const message = await generateCheckInMessage(user.phone_number, lastMood);
        await client.sendMessage(user.phone_number, message);
        await storeMessage(user.phone_number, message, true);
        
        logger.debug(`⏰ Sent check-in to ${user.phone_number}`);
      } catch (err) {
        logger.error(`⏰ Check-in failed for ${user.phone_number}:`, err);
      }
    }
  } catch (err) {
    logger.error('⏰ Daily check-in job failed:', err);
  }
}

async function generateCheckInMessage(phoneNumber, mood) {
  try {
    const { rows: [user] } = await db.query(
      'SELECT name FROM users WHERE phone_number = $1',
      [phoneNumber]
    );
    
    const prompt = `Generate a ${mood}-appropriate check-in for ${user?.name || 'friend'}`;
    logger.debug(`💌 Generating check-in with prompt: "${prompt}"`);
    
    return await getAIResponse(prompt, [], { isCheckIn: true });
  } catch (err) {
    logger.error('💌 Check-in message generation failed:', err);
    return "Hey! Just checking in on you today 💛";
  }
}

const checkInJob = scheduleJob(CHECK_IN_INTERVAL, sendDailyCheckIn);
logger.info(`⏰ Scheduled check-ins at: ${CHECK_IN_INTERVAL}`);

// ======================
// 9. MESSAGE HANDLER (WITH DEBUG)
// ======================
client.on('message', async message => {
  try {
    // Skip status messages and group chats
    if (message.isStatus || message.from.includes("@g.us")) {
      logger.debug(`🚫 Ignored ${message.isStatus ? 'status' : 'group'} message`);
      return;
    }

    const phoneNumber = message.from;
    const userMessage = message.body.trim();
    const lowerMessage = userMessage.toLowerCase();

    logger.debug(`📩 Received message from ${phoneNumber}: "${userMessage.substring(0, 30)}..."`);

    // Onboarding flow
    if (lowerMessage.includes('hey stink')) {
      if (!userStates[phoneNumber]) {
        userStates[phoneNumber] = 'awaiting_name';
        logger.debug(`🆕 New user onboarding started for ${phoneNumber}`);
        await client.sendMessage(phoneNumber, "Heyyy...😃I'm StinkStink, but you can call me Stink😚. I'm like a therapist but not really qualified. What matters is that you know you can talk to me about anything. I just hope we can be friends.💛 So what's your name?");
        return;
      }
    }

    if (userStates[phoneNumber] === 'awaiting_name') {
      const userName = userMessage.trim();
      const gender = detectGenderFromName(userName);
      
      userDataCache[phoneNumber] = { name: userName };
      logger.debug(`🆕 User provided name: "${userName}", detected gender: ${gender}`);

      if (gender !== 'unknown') {
        await saveUserProfile(phoneNumber, {
          name: userName,
          gender: gender,
          ageBracket: estimateAgeBracket(userMessage)
        });
        await client.sendMessage(
          phoneNumber,
          `Nice to meet you, ${userName}! What's on your mind?`
        );
        userStates[phoneNumber] = 'active';
        logger.debug(`✅ Completed onboarding for ${phoneNumber}`);
      } else {
        userStates[phoneNumber] = 'awaiting_gender';
        await client.sendMessage(
          phoneNumber,
          `Is ${userName} a boy's or girl's name? (or "skip")`
        );
        logger.debug(`❓ Requesting gender clarification for ${userName}`);
      }
      return;
    }

    if (userStates[phoneNumber] === 'awaiting_gender') {
      let gender = 'other';
      if (lowerMessage.includes('boy')) gender = 'male';
      if (lowerMessage.includes('girl')) gender = 'female';
      if (lowerMessage.includes('skip')) gender = 'prefer not to say';
      
      logger.debug(`🆕 User provided gender: ${gender}`);
      
      await saveUserProfile(phoneNumber, {
        ...userDataCache[phoneNumber],
        gender: gender,
        ageBracket: estimateAgeBracket(lowerMessage)
      });
      
      userStates[phoneNumber] = 'active';
      await client.sendMessage(phoneNumber, `Cool cool, soooo....how are you feeling today? Anything crazy happened lately?😙`);
      return;
    }

    // Active conversation handling
    if (userStates[phoneNumber] === 'active') {
      const mood = detectMood(userMessage);
      logger.debug(`😊 Detected mood: ${mood} for message`);
      
      await storeMessage(phoneNumber, userMessage, false, mood);
      
      const history = await getChatHistory(phoneNumber);
      const { rows: [user] } = await db.query(
        'SELECT name, gender, age_bracket FROM users WHERE phone_number = $1',
        [phoneNumber]
      );
      
      logger.debug(`🧠 Generating AI response with ${history.length} context messages`);
      const aiReply = await getAIResponse(userMessage, history, user);
      const finalReply = enhanceWithEmoji(limitResponseLength(aiReply), mood);
      
      logger.debug(`📤 Sending response: ${finalReply.substring(0, 30)}...`);
      await storeMessage(phoneNumber, finalReply, true);
      await sendLongMessage(phoneNumber, finalReply);

      // Mood-based suggestions
      if (mood === 'sad' && Math.random() > 0.5) {
        logger.debug(`💡 Generating suggestion for sad mood`);
        const suggestion = await getAIResponse(
          "Suggest a helpful activity or music for someone feeling sad",
          [],
          { isSuggestion: true }
        );
        await saveSuggestion(phoneNumber, mood, suggestion);
        await client.sendMessage(phoneNumber, `💡 Suggestion: ${suggestion}`);
      }
    }
  } catch (error) {
    logger.error("💥 Message handler crashed:", {
      error: error.message,
      stack: error.stack,
      from: message?.from
    });
    await client.sendMessage(
      message.from, 
      "Oops, my circuits glitched! 🫠 Try again?"
    );
  }
});

// ======================
// 10. BOT INITIALIZATION (WITH DEBUG)
// ======================
client.on('qr', qr => {
  logger.info('🔍 Scan QR Code:');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  logger.info('✅ WhatsApp authenticated!');
});

client.on('auth_failure', msg => {
  logger.error('❌ Auth failed:', msg);
});

client.on('ready', () => {
  logger.info('🤖 Bot is fully ready!');
  logger.info(`Logged in as: ${client.info.pushname}`);
});

client.on('disconnected', reason => {
  logger.warn('⚠️ Disconnected:', reason);
});

// Initialize with error handling
try {
  client.initialize();
  logger.info('🔄 Initializing WhatsApp client...');
} catch (err) {
  logger.error('🚨 Initialization crashed:', err);
  process.exit(1);
}

// Error handling
process.on('unhandledRejection', err => {
  logger.error('🔥 Unhandled rejection:', err);
});

process.on('SIGINT', async () => {
  logger.info('\n🛑 Shutting down gracefully...');
  try {
    checkInJob.cancel();
    await client.destroy();
    await db.end();
    logger.info('✅ Clean shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('❌ Shutdown failed:', err);
    process.exit(1);
  }
});

logger.info("🚀 Stink bot starting...");