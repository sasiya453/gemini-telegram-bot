from flask import Flask, request
import telebot
import google.generativeai as genai
import os
import traceback

# Initialize Flask
app = Flask(__name__)

# CONFIGURATION - Get keys from Vercel
GEMINI_KEY = os.environ.get("GEMINI_API_KEY")
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN")

# Setup Gemini
if GEMINI_KEY:
    genai.configure(api_key=GEMINI_KEY)
    model = genai.GenerativeModel('gemini-1.5-flash')

# Setup Telegram
if TELEGRAM_TOKEN:
    bot = telebot.TeleBot(TELEGRAM_TOKEN, threaded=False)

# --- THE MISSING PART: Message Handler ---
@bot.message_handler(func=lambda message: True)
def handle_message(message):
    try:
        # Check if keys are loaded
        if not GEMINI_KEY:
            bot.reply_to(message, "⚠️ Error: GEMINI_API_KEY is missing in Vercel!")
            return

        # Send "typing..." status
        bot.send_chat_action(message.chat.id, 'typing')

        # Generate content
        response = model.generate_content(message.text)
        
        # Reply to user
        bot.reply_to(message, response.text)

    except Exception as e:
        # THIS IS CRITICAL: It sends the specific error to your chat
        error_details = traceback.format_exc()
        # Print to Vercel logs for debugging
        print(f"ERROR: {error_details}")
        # Send short error to Telegram
        bot.reply_to(message, f"⚠️ System Error: {str(e)}")
# -----------------------------------------

@app.route('/webhook', methods=['POST'])
def webhook():
    if request.headers.get('content-type') == 'application/json':
        json_string = request.get_data().decode('utf-8')
        update = telebot.types.Update.de_json(json_string)
        bot.process_new_updates([update])
        return ''
    else:
        return 'Error', 403

@app.route('/')
def index():
    return "Bot is running!"
