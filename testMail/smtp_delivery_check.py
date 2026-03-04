
import sys

import csv
import smtplib
import imaplib
import email
import time
import uuid
import datetime
import os
import glob
import pandas as pd
from email.mime.text import MIMEText
from email.header import decode_header

# Configuration
DEFAULT_CSV_NAME = 'mailboxes_dev.csv'
SMTP_SERVER = 'mail.cazehiresense.com'
SMTP_PORT = 587
SMTP_USE_TLS = True

def get_imap_server(email_address):
    domain = email_address.split('@')[-1]
    if 'gmail.com' in domain:
        return 'imap.gmail.com'
    elif 'outlook.com' in domain or 'hotmail.com' in domain:
        return 'outlook.office365.com'
    elif 'yahoo.com' in domain:
        return 'imap.mail.yahoo.com'
    else:
        return f'mail.{domain}'

def send_email(sender_email, sender_password, receiver_email, subject):
    try:
        msg = MIMEText("This is a test email to verify SMTP configuration.")
        msg['Subject'] = subject
        msg['From'] = sender_email
        msg['To'] = receiver_email

        server = smtplib.SMTP(SMTP_SERVER, SMTP_PORT)
        server.ehlo()
        if SMTP_USE_TLS:
            server.starttls()
            server.ehlo()
        
        server.login(sender_email, sender_password)
        server.sendmail(sender_email, receiver_email, msg.as_string())
        server.quit()
        return True, "sent"
    except Exception as e:
        return False, str(e)

def verify_emails_bulk(receiver_email, receiver_password, imap_server, sent_subjects, start_date):
    """
    Connects to IMAP once and checks for all subjects in sent_subjects.
    Returns a set of found subjects.
    """
    found_subjects = set()
    try:
        print(f"Connecting to IMAP {imap_server}...")
        mail = imaplib.IMAP4_SSL(imap_server)
        mail.login(receiver_email, receiver_password)
        mail.select("inbox")

        # Search for emails since the script started
        # IMAP date format: "30-Jan-2025"
        date_str = start_date.strftime("%d-%b-%Y")
        print(f"Fetching emails since {date_str}...")
        
        status, messages = mail.search(None, f'(SINCE "{date_str}")')
        
        if status != "OK":
            print("Failed to search inbox.")
            return found_subjects

        email_ids = messages[0].split()
        print(f"Found {len(email_ids)} emails in search range. Checking headers...")

        for e_id in email_ids:
            # Fetch headers only
            _, msg_data = mail.fetch(e_id, '(BODY.PEEK[HEADER.FIELDS (SUBJECT)])')
            for response_part in msg_data:
                if isinstance(response_part, tuple):
                    msg = email.message_from_bytes(response_part[1])
                    subject, encoding = decode_header(msg["Subject"])[0]
                    if isinstance(subject, bytes):
                        subject = subject.decode(encoding if encoding else "utf-8")
                    
                    if subject in sent_subjects:
                        found_subjects.add(subject)
        
        mail.logout()
    except Exception as e:
        print(f"IMAP Error: {e}")
    
    return found_subjects

def load_accounts():
    """
    Loads accounts from an Excel or CSV file.
    Prioritizes .xlsx files in the current directory.
    """
    # 1. Look for XLSX files
    xlsx_files = glob.glob("*.xlsx")
    file_path = None
    
    if xlsx_files:
        print(f"Found Excel file(s): {xlsx_files}")
        file_path = xlsx_files[0] # Pick the first one
        print(f"Using: {file_path}")
    elif os.path.exists(DEFAULT_CSV_NAME):
         print(f"No Excel file found. Using default CSV: {DEFAULT_CSV_NAME}")
         file_path = DEFAULT_CSV_NAME
    else:
        # Prompt user
        file_path = input("Enter the path to your Excel or CSV file: ").strip()
    
    if not file_path or not os.path.exists(file_path):
        print("Error: File not found.")
        return []

    try:
        if file_path.endswith('.xlsx'):
            df = pd.read_excel(file_path)
        else:
            df = pd.read_csv(file_path)
        
        # Normalize columns
        df.columns = [c.strip().lower() for c in df.columns]
        
        required_cols = {'email', 'app_password'}
        if not required_cols.issubset(df.columns):
            print(f"Error: File must contain columns: {required_cols}. Found: {df.columns}")
            # Try to map if close enough? No, let's strict for now or ask.
            return []
            
        return df.to_dict('records')
        
    except Exception as e:
        print(f"Error reading file: {e}")
        return []

def main():
    print("--- SMTP Delivery Checker (Bulk Mode) ---")
    
    receiver_email = input("Enter Receiver Email: ").strip()
    receiver_password = input("Enter Receiver App Password: ").strip()
    
    if not receiver_email or not receiver_password:
        print("Receiver credentials are required.")
        return

    imap_server = get_imap_server(receiver_email)
    print(f"Using IMAP Server: {imap_server}")

    # Load Accounts
    accounts = load_accounts()

    if not accounts:
        print("No accounts loaded. Exiting.")
        return

    print(f"Found {len(accounts)} accounts to test.")
    
    start_time = datetime.datetime.now()
    sent_data = {} # subject -> sender_email
    results = []

    print("\n[Phase 1] Sending emails...")
    for idx, account in enumerate(accounts):
        sender_email = account.get('email')
        sender_app_password = account.get('app_password')
        
        if not sender_email or not sender_app_password:
            print(f"Skipping row {idx+1}: Missing email or app_password")
            continue

        unique_id = str(uuid.uuid4())[:12]
        subject = f"SMTP Check {unique_id}"
        
        sys.stdout.write(f"\r[{idx+1}/{len(accounts)}] Sending from {sender_email} ... ")
        sys.stdout.flush()
        
        success, msg = send_email(sender_email, sender_app_password, receiver_email, subject)
        
        if success:
            sent_data[subject] = sender_email
            print("OK")
        else:
            print(f"FAILED ({msg})")
            results.append({'email': sender_email, 'status': 'FAILURE', 'details': f"SMTP Error: {msg}"})
        
        # Rate limiting: don't bombard the SMTP server
        time.sleep(0.5)

    print(f"\n[Phase 1 Complete] Sent {len(sent_data)} emails successfully.")
    
    if not sent_data:
        print("No emails were sent. Exiting.")
        return

    print(f"Waiting 30 seconds for delivery propagation...")
    time.sleep(30)

    print("\n[Phase 2] Verifying delivery...")
    
    # We pass the set of subjects we expect
    expected_subjects = set(sent_data.keys())
    found_subjects = verify_emails_bulk(receiver_email, receiver_password, imap_server, expected_subjects, start_time)
    
    print(f"Found {len(found_subjects)} matching emails in inbox.")

    # Correlate results
    for subject, sender_email in sent_data.items():
        if subject in found_subjects:
            results.append({'email': sender_email, 'status': 'SUCCESS', 'details': 'Sent and Verified'})
        else:
            results.append({'email': sender_email, 'status': 'FAILURE', 'details': 'Sent but NOT FOUND in inbox'})

    # Summary
    print("\n--- Summary ---")
    success_count = sum(1 for r in results if r['status'] == 'SUCCESS')
    print(f"Total Tested: {len(accounts)}")
    print(f"Successful: {success_count}")
    print(f"Failed: {len(results) - success_count}")
    
    # Save report
    report_file = "smtp_check_report.csv"
    with open(report_file, "w", newline="", encoding="utf-8") as f:
        fieldnames = ['email', 'status', 'details']
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(results)
    print(f"Detailed report saved to {report_file}")

if __name__ == "__main__":
    main()