import csv
import requests
import time

MAILCOW_API_URL = "https://mail.cazehiresense.com/api/v1/delete/mailbox"
API_KEY = "F08E59-9111B7-95AACF-9F3629-7B853E"

headers = {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json"
}

success_count = 0
fail_count = 0
skip_count = 0

# Mailboxes to skip (preserve these)
SKIP_EMAILS = ["manoj@cazehiresense.com"]

with open("mailboxes.csv", newline="") as csvfile:
    reader = csv.DictReader(csvfile)

    for row in reader:
        email = row["email"]
        
        # Skip protected mailboxes
        if email in SKIP_EMAILS:
            print(f"⏭️ Skipped (protected): {email}")
            skip_count += 1
            continue
        
        # Mailcow delete API expects a list of emails
        payload = [email]

        response = requests.post(
            MAILCOW_API_URL,
            headers=headers,
            json=payload
        )

        try:
            result = response.json()
            if isinstance(result, list) and len(result) > 0:
                msg_type = result[0].get("type", "")
                msg = result[0].get("msg", "")
                if msg_type == "success":
                    print(f"🗑️ Deleted: {email}")
                    success_count += 1
                else:
                    print(f"❌ Failed: {email} → {msg}")
                    fail_count += 1
            else:
                print(f"⚠️ Unexpected response for {email}: {result}")
                fail_count += 1
        except Exception as e:
            print(f"❌ Error parsing response for {email}: {e}")
            fail_count += 1
        
        # Small delay to avoid rate limiting
        time.sleep(0.1)

print(f"\n📊 Summary: {success_count} deleted, {fail_count} failed, {skip_count} skipped")
