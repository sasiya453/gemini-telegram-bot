from flask import Flask, request
import telebot
import requests
import os

app = Flask(__name__)

# ENV VARS
GEMINI_KEY = os.environ.get("GEMINI_API_KEY")
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN")

# Initialize Telegram bot
bot = telebot.TeleBot(TELEGRAM_TOKEN, threaded=False)


# --- Gemini API Function ---
def ask_gemini(text):
    if not GEMINI_KEY:
        return "⚠️ Missing Gemini API key."

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key={GEMINI_KEY}"

    headers = {"Content-Type": "application/json"}

    payload = {
        "contents": [
            {"parts": [{"text": text}]}
        ]
    }

    try:
        r = requests.post(url, headers=headers, json=payload, timeout=15)

        if r.status_code != 200:
            return f"⚠️ Google Error {r.status_code}: {r.text}"

        data = r.json()
        return data["candidates"][0]["content"]["parts"][0]["text"]

    except Exception as e:
        return f"⚠️ Error communicating with Gemini: {str(e)}"


# --- Telegram Message Handler ---
@bot.message_handler(func=lambda msg: True)
def handle_message(message):
    user_text = message.text

    bot.send_chat_action(message.chat.id, "typing")

    reply = ask_gemini(user_text)

    bot.reply_to(message, reply)


# --- Flask Webhook Handler ---
@app.route("/webhook", methods=["POST"])
def webhook():
    if request.headers.get('content-type') == 'application/json':
        json_str = request.get_data().decode("utf-8")
        update = telebot.types.Update.de_json(json_str)
        bot.process_new_updates([update])
        return ""
    return "Unauthorized", 403


@app.route("/")
def home():
    return "Gemini Telegram bot is running on Vercel!"


