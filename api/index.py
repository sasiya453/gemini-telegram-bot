from flask import Flask, request
import telebot
import google.generativeai as genai
import os

# 1. Initialize Flask App
app = Flask(__name__)

# 2. Configuration (Get keys from Vercel)
GEMINI_KEY = os.environ.get("GEMINI_API_KEY")
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN")

# 3. Initialize Gemini AI
if GEMINI_KEY:
    genai.configure(api_key=GEMINI_KEY)
    # Using 'gemini-1.5-flash' (Standard) - if it fails, try 'gemini-pro'
    model = genai.GenerativeModel('gemini-1.5-flash')
else:
    print("Error: GEMINI_API_KEY is missing!")

# 4. Initialize Telegram Bot
if TELEGRAM_TOKEN:
    # threaded=False is REQUIRED for Vercel
    bot = telebot.TeleBot(TELEGRAM_TOKEN, threaded=False)
else:
    print("Error: TELEGRAM_TOKEN is missing!")

# --- THIS WAS MISSING BEFORE ---
# 5. The "Brain" (Handle Message)
@bot.message_handler(func=lambda message: True)
def handle_message(message):
    # This function runs whenever a user sends a text message
    try:
        if not GEMINI_KEY:
            bot.reply_to(message, "⚠️ Error: GEMINI_API_KEY is missing in Vercel.")
            return

        # Show "typing..." status in Telegram
        bot.send_chat_action(message.chat.id, 'typing')

        # Ask Gemini
        response = model.generate_content(message.text)
        
        # Send Gemini's answer back to the user
        bot.reply_to(message, response.text)

    except Exception as e:
        # If something crashes, send the error to the chat
        error_msg = f"⚠️ System Error: {str(e)}"
        print(error_msg)
        bot.reply_to(message, error_msg)
# -------------------------------

# 6. Webhook Route (Telegram talks to this)
@app.route('/webhook', methods=['POST'])
def webhook():
    if request.headers.get('content-type') == 'application/json':
        json_string = request.get_data().decode('utf-8')
        update = telebot.types.Update.de_json(json_string)
        bot.process_new_updates([update])
        return ''
    else:
        return 'Error', 403

# 7. Health Check Route
@app.route('/')
def index():
    status = "Online"
    if not GEMINI_KEY: status += " | Gemini Key Missing"
    if not TELEGRAM_TOKEN: status += " | Telegram Token Missing"
    return status
