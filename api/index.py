from flask import Flask, request
import telebot
import requests
import os
import traceback

app = Flask(__name__)

# CONFIGURATION
GEMINI_KEY = os.environ.get("GEMINI_API_KEY")
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN")

# Initialize Bot
if TELEGRAM_TOKEN:
    bot = telebot.TeleBot(TELEGRAM_TOKEN, threaded=False)

def ask_gemini_directly(text):
    """
    Sends a direct HTTP request to Google, bypassing the buggy library.
    """
    if not GEMINI_KEY:
        return "Error: API Key missing."
    
    # URL for the FLASH model (Direct REST API)
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={GEMINI_KEY}"
    
    headers = {"Content-Type": "application/json"}
    payload = {
        "contents": [{
            "parts": [{"text": text}]
        }]
    }
    
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=10)
        
        # Check for HTTP errors (404, 403, 500)
        if response.status_code != 200:
            return f"⚠️ Google Error ({response.status_code}): {response.text}"
            
        data = response.json()
        
        # Extract the answer from the complex JSON
        try:
            return data['candidates'][0]['content']['parts'][0]['text']
        except (KeyError, IndexError):
            # Sometimes Gemini blocks content for safety and returns no text
            return "Gemini blocked this response (Safety Filter)."
            
    except Exception as e:
        return f"⚠️ Connection Error: {str(e)}"

@bot.message_handler(func=lambda message: True)
def handle_message(message):
    try:
        # 1. Typing indicator
        bot.send_chat_action(message.chat.id, 'typing')

        # 2. Get Answer using the new Direct Function
        reply = ask_gemini_directly(message.text)
        
        # 3. Send Reply
        bot.reply_to(message, reply)

    except Exception as e:
        bot.reply_to(message, f"System Error: {str(e)}")

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
    return "Bot is running (Direct Mode)"
