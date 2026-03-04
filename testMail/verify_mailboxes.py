import requests

MAILCOW_API_URL = "https://mail.cazehiresense.com/api/v1/get/mailbox/all"
API_KEY = "F08E59-9111B7-95AACF-9F3629-7B853E"

headers = {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json"
}

response = requests.get(MAILCOW_API_URL, headers=headers)

if response.status_code == 200:
    mailboxes = response.json()
    print(f"📊 Total mailboxes found: {len(mailboxes)}")
    print("\n📧 Mailbox list:")
    for i, mb in enumerate(mailboxes, 1):
        username = mb.get("username", "N/A")
        active = "✅" if mb.get("active") == 1 else "❌"
        print(f"  {i:3}. {active} {username}")
else:
    print(f"❌ Failed to fetch mailboxes: {response.status_code}")
    print(response.text)
