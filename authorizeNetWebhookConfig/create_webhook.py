# Functions for establishing webhooks with authorize.net

import base64
import os
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")


def generate_basic_auth_header() -> str:
    login_id = os.getenv("AUTHNET_LOGIN_ID") or input("Enter API Login ID: ")
    transaction_key = os.getenv("AUTHNET_TRANSACTION_KEY") or input("Enter Transaction Key: ")
    credentials = f"{login_id}:{transaction_key}"
    encoded = base64.b64encode(credentials.encode()).decode()
    return f"Basic {encoded}"


def get_event_types() -> list:
    url = "https://api.authorize.net/rest/v1/eventtypes"
    headers = {"Authorization": generate_basic_auth_header()}
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    return response.json()

def create_webhook() -> dict:
    url = "https://api.authorize.net/rest/v1/webhooks"
    headers = {"Authorization": generate_basic_auth_header()}
    payload = {
        "name": "Google Ads Webhook",
        "url": "http://192.241.152.156/webhook/authorizenet",
        "eventTypes": [
            "net.authorize.payment.authcapture.created",
            "net.authorize.payment.refund.created",
        ],
        "status": "inactive",
    }
    response = requests.post(url, json=payload, headers=headers)
    response.raise_for_status()
    return response.json()


def list_webhooks() -> list:
    url = "https://api.authorize.net/rest/v1/webhooks"
    headers = {"Authorization": generate_basic_auth_header()}
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    return response.json()


def ping_webhook(webhook_id: str) -> None:
    url = f"https://api.authorize.net/rest/v1/webhooks/{webhook_id}/pings"
    headers = {"Authorization": generate_basic_auth_header()}
    response = requests.post(url, headers=headers)
    response.raise_for_status()


def test_all_webhooks() -> None:
    webhooks = list_webhooks()
    print(f"Found {len(webhooks)} webhook(s)\n")
    for webhook in webhooks:
        webhook_id = webhook.get("webhookId")
        print("=" * 60)
        print(f"ID:          {webhook_id}")
        print(f"Name:        {webhook.get('name')}")
        print(f"URL:         {webhook.get('url')}")
        print(f"Status:      {webhook.get('status')}")
        print(f"Event Types: {', '.join(webhook.get('eventTypes', []))}")
        print(f"Created:     {webhook.get('createdDate')}")
        print(f"Updated:     {webhook.get('updatedDate')}")

        if webhook.get("status") != "inactive":
            print("Ping skipped: webhook must be inactive to ping")
        else:
            try:
                url = f"https://api.authorize.net/rest/v1/webhooks/{webhook_id}/pings"
                headers = {"Authorization": generate_basic_auth_header()}
                response = requests.post(url, headers=headers)
                print(f"Ping status: {response.status_code} {response.reason}")
                if response.text:
                    print(f"Ping response: {response.text}")
                else:
                    print("Ping response: (empty — success)")
            except requests.exceptions.HTTPError as e:
                print(f"Ping failed: {e}")
        print()


def update_webhook_statuses() -> None:
    auth_header = {"Authorization": generate_basic_auth_header()}
    webhooks = list_webhooks()
    print(f"Found {len(webhooks)} webhook(s)\n")

    for webhook in webhooks:
        webhook_id = webhook.get("webhookId")
        current_status = webhook.get("status")
        print("=" * 60)
        print(f"ID:     {webhook_id}")
        print(f"Name:   {webhook.get('name')}")
        print(f"URL:    {webhook.get('url')}")
        print(f"Status: {current_status}")

        answer = input("Change status? (y/n): ").strip().lower()
        if answer != "y":
            print("Skipped.\n")
            continue

        new_status = input("Set to 'active' or 'inactive': ").strip().lower()
        if new_status not in ("active", "inactive"):
            print("Invalid input — must be 'active' or 'inactive'. Skipped.\n")
            continue

        if new_status == current_status:
            print(f"Already {current_status}. Skipped.\n")
            continue

        url = f"https://api.authorize.net/rest/v1/webhooks/{webhook_id}"
        response = requests.put(url, json={"status": new_status}, headers=auth_header)
        response.raise_for_status()
        print(f"Updated to '{new_status}' successfully.\n")


test_all_webhooks()
update_webhook_statuses()