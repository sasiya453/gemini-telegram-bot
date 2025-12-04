from flask import Flask, request
import telebot
import google.generativeai as genai
import os

# Initialize Flask
app = Flask(__name__)

# Initialize Gemini
# We use os.environ to get keys from Vercel settings later
genai.configure(api_key=os.environ["GEMINI_API_KEY"])
model = genai.GenerativeModel('gemini-1.5-flash')

# Initialize Telegram Bot
bot = telebot.TeleBot(os.environ["TELEGRAM_TOKEN"], threaded=False)

# Handle incoming messages
@bot.message_handler(func=lambda message: True)
def handle_message(message):
    try:
        # Send user text to Gemini
        response = model.generate_content(message.text)
        reply_text = response.text
        
        # Send Gemini's reply back to Telegram
        bot.reply_to(message, reply_text)
except Exception as e:
        # This will send the actual technical error to your chat
        bot.reply_to(message, f"Error details: {str(e)}")

# The Webhook Route (This is what Telegram calls)
@app.route('/webhook', methods=['POST'])
def webhook():
    if request.headers.get('content-type') == 'application/json':
        json_string = request.get_data().decode('utf-8')
        update = telebot.types.Update.de_json(json_string)
        bot.process_new_updates([update])
        return ''
    else:
        return 'Error', 403

# Home Route (To check if bot is alive)
@app.route('/')
def index():
    return "Bot is running!"

