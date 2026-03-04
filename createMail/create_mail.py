import csv
import requests
import time

MAILCOW_API_URL = "https://mail.cazehiresense.com/api/v1/add/mailbox"
API_KEY = "F08E59-9111B7-95AACF-9F3629-7B853E"

headers = {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json"
}

success_count = 0
fail_count = 0

with open("mailboxes.csv", newline="") as csvfile:
    reader = csv.DictReader(csvfile)

    for row in reader:
        payload = {
            "active": 1,
            "domain": row["email"].split("@")[1],
            "local_part": row["email"].split("@")[0],
            "name": row["name"],
            "password": row["password"],
            "password2": row["password"],
            "quota": 0,  # 0 = unlimited (uses domain default)
            "force_pw_update": 0,
            "tls_enforce_in": 0,
            "tls_enforce_out": 0
        }

        response = requests.post(
            MAILCOW_API_URL,
            headers=headers,
            json=payload
        )

        # Mailcow API returns 200 even on errors, so check response body
        try:
            result = response.json()
            # Mailcow returns a list with type "success" or "danger"/"error"
            if isinstance(result, list) and len(result) > 0:
                msg_type = result[0].get("type", "")
                msg = result[0].get("msg", "")
                if msg_type == "success":
                    print(f"✅ Created: {row['email']}")
                    success_count += 1
                else:
                    print(f"❌ Failed: {row['email']} → {msg}")
                    fail_count += 1
            else:
                print(f"⚠️ Unexpected response for {row['email']}: {result}")
                fail_count += 1
        except Exception as e:
            print(f"❌ Error parsing response for {row['email']}: {e}")
            fail_count += 1
        
        # Small delay to avoid rate limiting
        time.sleep(0.1)

print(f"\n📊 Summary: {success_count} created, {fail_count} failed")