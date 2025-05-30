# Bitespeed Backend Task: Identity Reconciliation

This project implements a backend service for Bitespeed to handle identity reconciliation based on incoming email addresses and phone numbers.

## Project Overview

The service provides a single endpoint `/identify` which accepts `POST` requests with a JSON body containing an optional `email` and `phoneNumber`.

Based on the provided information, the service identifies existing contacts, links them according to the specified rules (oldest contact is primary), creates new contacts (primary or secondary) as needed, and returns a consolidated contact view.

## Technology Stack

*   **Backend Framework:** Node.js with Express
*   **Language:** TypeScript
*   **Database ORM:** Prisma
*   **Database:** SQLite

## Setup and Running Locally

1.  **Clone the repository (if applicable).**
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Generate Prisma Client and run migrations:**
    ```bash
    npx prisma generate
    npx prisma migrate dev --name init
    ```
4.  **Build the TypeScript code:**
    ```bash
    npm run build
    ```
5.  **Start the server:**
    ```bash
    npm start
    ```
    The server will run on `http://localhost:3000` by default.

## API Endpoint

*   **URL:** `/identify`
*   **Method:** `POST`
*   **Request Body (JSON):**
    ```json
    {
      "email": "user@example.com", // Optional
      "phoneNumber": "1234567890" // Optional (as string or number)
    }
    ```
*   **Success Response (200 OK):**
    ```json
    {
      "contact": {
        "primaryContatctId": 1,
        "emails": ["primary@example.com", "secondary@example.com"],
        "phoneNumbers": ["1112223333", "4445556666"],
        "secondaryContactIds": [2, 3]
      }
    }
    ```
*   **Error Responses:**
    *   `400 Bad Request`: If neither email nor phoneNumber is provided.
    *   `500 Internal Server Error`: For server-side issues.
