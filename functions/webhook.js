// functions/webhook.js

// Direct mappings for critical numbers - Add your most important contacts here
const DIRECT_MAPPINGS = {
  '+18884640727': ['capitalone@example.com'], // Capital One - Now supports multiple emails
  '+12819412710': ['mashaimw@osbprovider.com'], // Maya - FIXED EMAIL ADDRESS
  '+19513958599': ['maurice@example.com'], // Maurice Miles
  '+13127802300': ['pj@targetron.com'], // PJ Entrepreneur
  '+17138620001': ['support@salesnexus.com'] // SalesNexus Support
};

// Direct mappings to contact IDs
const DIRECT_CONTACT_MAPPINGS = {
  '+18884640727': 'cea99ef5-c1e1-4ad5-a73a-bd74144e71a6' // Capital One contact ID
  // Add other contact IDs as needed
};

// For in-memory caching between webhooks in the same execution context
const callDetailsStore = {};

// Import Firebase (make sure to install these packages in your Netlify function)
const admin = require('firebase-admin');

// Initialize Firebase if not already initialized
let firebaseInitialized = false;
function initializeFirebase() {
  if (!firebaseInitialized) {
    try {
      // Use the FIREBASE_SERVICE_ACCOUNT environment variable
      let serviceAccount;
      
      try {
        // Try to parse the service account JSON from the environment variable
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log("Successfully parsed service account from environment variable");
      } catch (parseError) {
        console.error("Error parsing service account:", parseError);
        // If parsing fails, try to use it directly (in case it's already an object)
        serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
      }

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      
      firebaseInitialized = true;
      console.log("Firebase initialized successfully");
    } catch (error) {
      console.error("Error initializing Firebase:", error);
      console.error("Firebase environment variables:", {
        project_id: process.env.FIREBASE_PROJECT_ID ? "set" : "not set",
        service_account: process.env.FIREBASE_SERVICE_ACCOUNT ? "set" : "not set"
      });
    }
  }
  
  return firebaseInitialized;
}

// Store call details in Firebase
async function storeCallDetailsInFirebase(callId, phoneNumbers) {
  try {
    if (!callId || !phoneNumbers || !phoneNumbers.from || !phoneNumbers.to) {
      console.log("Invalid call details provided for storage");
      return false;
    }
    
    try {
      const initialized = initializeFirebase();
      
      if (!initialized) {
        console.log("Firebase not initialized, using backup storage");
        return false;
      }
      
      // Special handling for direct mapped numbers
      const isDirectMapped = DIRECT_MAPPINGS[phoneNumbers.from] || DIRECT_MAPPINGS[phoneNumbers.to] || 
                             DIRECT_CONTACT_MAPPINGS[phoneNumbers.from] || DIRECT_CONTACT_MAPPINGS[phoneNumbers.to];
      
      if (isDirectMapped) {
        console.log(`Storing direct mapped phone numbers for call ${callId}`);
      }
      
      const db = admin.firestore();
      
      // Store with TTL of 1 hour (we'll automatically delete old entries)
      await db.collection('callDetails').doc(callId).set({
        from: phoneNumbers.from,
        to: phoneNumbers.to,
        isDirectMapped: !!isDirectMapped,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        expireAt: new Date(Date.now() + 60 * 60 * 1000) // 1 hour from now
      });
      
      console.log(`Successfully stored call details in Firebase for call ${callId}`);
      return true;
    } catch (error) {
      console.error("Error storing in Firebase:", error);
      return false;
    }
  } catch (error) {
    console.error("Error storing call details:", error);
    return false;
  }
}

// Retrieve call details from Firebase
async function getCallDetailsFromFirebase(callId) {
  try {
    if (!callId) {
      console.log("No callId provided for retrieval");
      return null;
    }
    
    try {
      const initialized = initializeFirebase();
      
      if (!initialized) {
        console.log("Firebase not initialized");
        return null;
      }
      
      console.log(`Attempting to retrieve call details from Firebase for call ID: ${callId}`);
      const db = admin.firestore();
      
      const doc = await db.collection('callDetails').doc(callId).get();
      
      if (doc.exists) {
        const data = doc.data();
        console.log(`Successfully retrieved call details from Firebase for call ${callId}`);
        return {
          from: data.from || "",
          to: data.to || "",
          isDirectMapped: data.isDirectMapped || false
        };
      } else {
        console.log(`No call details found in Firebase for call ${callId}`);
        return null;
      }
    } catch (error) {
      console.error("Error retrieving from Firebase:", error);
      return null;
    }
  } catch (error) {
    console.error("Error retrieving call details:", error);
    return null;
  }
}

exports.handler = async function(event, context) {
  try {
    // Parse the webhook payload from OpenPhone
    const payload = JSON.parse(event.body);
    console.log("Received webhook from OpenPhone:", JSON.stringify(payload));

    // Extract call ID and store it for consistent handling across webhooks
    let callId = "";
    
    // The structure of the payload differs by webhook type
    if (payload.type && payload.type.includes("recording")) {
      // Recording webhooks have the call details directly in data.object
      if (payload.data && payload.data.object) {
        callId = payload.data.object.id || "";
      }
    } else if (payload.type && (payload.type.includes("transcript") || payload.type.includes("summary"))) {
      // Transcript and summary webhooks have the callId in data.object.callId
      if (payload.data && payload.data.object) {
        callId = payload.data.object.callId || "";
      }
    }
    
    console.log(`Processing call ID: ${callId}`);
    
    // Extract phone numbers from the webhook (for recording events)
    // For transcript and summary events, we'll try to retrieve from storage
    let phoneNumbers = { from: "", to: "" };
    
    if (payload.type && payload.type.includes("recording") && payload.data && payload.data.object) {
      // For recording events, extract numbers directly from the payload
      phoneNumbers.from = payload.data.object.from || "";
      phoneNumbers.to = payload.data.object.to || "";
      
      // Store these details in both in-memory cache and Firebase
      callDetailsStore[callId] = phoneNumbers;
      const storedSuccessfully = await storeCallDetailsInFirebase(callId, phoneNumbers);
      
      console.log(`Storing phone numbers for call ${callId}: From: ${phoneNumbers.from}, To: ${phoneNumbers.to}`);
      console.log(`Stored successfully: ${storedSuccessfully ? 'Yes' : 'No'}`);
      
    } else {
      // First try in-memory cache (for same execution context)
      if (callId && callDetailsStore[callId]) {
        phoneNumbers = callDetailsStore[callId];
        console.log(`Retrieved phone numbers from memory for call ${callId}: From: ${phoneNumbers.from}, To: ${phoneNumbers.to}`);
      } else {
        // If not in memory, try Firebase
        console.log(`Call details not found in memory for call ${callId}, trying Firebase...`);
        const firebasePhoneNumbers = await getCallDetailsFromFirebase(callId);
        
        if (firebasePhoneNumbers) {
          phoneNumbers = firebasePhoneNumbers;
          // Also store in memory for future use in this execution
          callDetailsStore[callId] = phoneNumbers;
          console.log(`Retrieved phone numbers from Firebase for call ${callId}: From: ${phoneNumbers.from}, To: ${phoneNumbers.to}`);
          
          // Direct mapping detection
          if (firebasePhoneNumbers.isDirectMapped) {
            console.log("Direct mapped call detected from Firebase data");
          }
        } else {
          console.log(`No stored phone numbers found for call ${callId} in memory or Firebase`);
        }
      }
    }
    
    console.log(`Phone numbers - From: ${phoneNumbers.from}, To: ${phoneNumbers.to}`);
    
    // Default to fallback contact ID
    let contactId = process.env.FALLBACK_CONTACT_ID;
    
    // First check for direct contact ID mappings
    if (DIRECT_CONTACT_MAPPINGS[phoneNumbers.from]) {
      contactId = DIRECT_CONTACT_MAPPINGS[phoneNumbers.from];
      console.log(`Direct contact mapping for ${phoneNumbers.from}: ${contactId}`);
    } else if (DIRECT_CONTACT_MAPPINGS[phoneNumbers.to]) {
      contactId = DIRECT_CONTACT_MAPPINGS[phoneNumbers.to];
      console.log(`Direct contact mapping for ${phoneNumbers.to}: ${contactId}`);
    } else {
      // Not directly mapped to a contact ID, so look up by email
      
      // Determine which phone number to use for contact matching
      // For outgoing calls (from your OpenPhone number), use the "to" number
      // For incoming calls (to your OpenPhone number), use the "from" number
      const direction = payload.data?.object?.direction || "outgoing";
      const lookupNumber = direction === "outgoing" ? phoneNumbers.to : phoneNumbers.from;
      
      console.log(`Using ${lookupNumber} to look up contact`);
      
      if (lookupNumber) {
        try {
          // First check direct mappings
          if (DIRECT_MAPPINGS[lookupNumber]) {
            const emails = DIRECT_MAPPINGS[lookupNumber];
            console.log(`Found emails in direct mappings: ${emails.join(', ')} for phone: ${lookupNumber}`);
            
            // Try each email until we find a contact
            const foundContactId = await findContactByEmails(emails);
            
            if (foundContactId) {
              contactId = foundContactId;
              console.log(`Found contact by direct mapping emails: ${contactId}`);
            } else {
              console.log(`No contact found for direct mapping emails: ${emails.join(', ')}, using fallback`);
            }
          } else {
            // Try the lookup function
            try {
              // INCREASED TIMEOUT: Adding a timeout of 5 seconds to give more time
              const emails = await lookupEmailsWithTimeout(lookupNumber, 5000);
              
              if (emails && emails.length > 0) {
                console.log(`Found email mappings: ${emails.join(', ')} for phone: ${lookupNumber}`);
                
                // Now find the contact by trying each email in SalesNexus
                const foundContactId = await findContactByEmails(emails);
                
                if (foundContactId) {
                  contactId = foundContactId;
                  console.log(`Found contact by lookup emails: ${contactId}`);
                } else {
                  console.log(`No contact found for emails: ${emails.join(', ')}, using fallback`);
                }
              } else {
                console.log(`No email mappings found for: ${lookupNumber}, using fallback`);
              }
            } catch (error) {
              console.error("Error looking up contact:", error);
            }
          }
        } catch (error) {
          console.error("Error in contact lookup process:", error);
        }
      }
    }
    
    console.log(`Using contact ID: ${contactId}`);
    
    // Handle different webhook event types from OpenPhone
    const webhookType = payload.type || "";
    
    if (webhookType.includes("recording")) {
      await handleRecording(payload, contactId);
    } else if (webhookType.includes("summary")) {
      await handleSummary(payload, contactId);
    } else if (webhookType.includes("transcript")) {
      await handleTranscript(payload, contactId);
    } else {
      console.log("Unhandled webhook type:", webhookType);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "Unhandled webhook type" })
      };
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Webhook processed successfully" })
    };
  } catch (error) {
    console.error("Error processing webhook:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to process webhook" })
    };
  }
};

// NEW: Lookup emails with a timeout - UPDATED TO HANDLE MULTIPLE EMAILS
async function lookupEmailsWithTimeout(phoneNumber, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      console.log(`Lookup timed out for ${phoneNumber} after ${timeoutMs}ms`);
      resolve([]);
    }, timeoutMs);
    
    lookupEmailsByPhoneNumber(phoneNumber, timeoutMs - 500)
      .then(emails => {
        clearTimeout(timeoutId);
        resolve(emails || []);
      })
      .catch(error => {
        console.error("Error in email lookup:", error);
        clearTimeout(timeoutId);
        resolve([]);
      });
  });
}

// NEW: Lookup emails by phone number - UPDATED TO HANDLE MULTIPLE EMAILS
async function lookupEmailsByPhoneNumber(phoneNumber, timeoutMs = 4500) {
  try {
    // Format the phone number
    const formattedPhone = formatPhoneNumber(phoneNumber);
    
    if (!formattedPhone) {
      console.log("Invalid phone number format:", phoneNumber);
      return [];
    }
    
    // Check direct mappings first
    if (DIRECT_MAPPINGS[formattedPhone]) {
      console.log(`Found emails in direct mappings: ${DIRECT_MAPPINGS[formattedPhone].join(', ')}`);
      return DIRECT_MAPPINGS[formattedPhone];
    }
    
    // Call our mapping function to get the emails
    try {
      const siteUrl = process.env.SITE_URL || 'https://sweet-liger-902232.netlify.app';
      console.log(`Looking up emails at: ${siteUrl}/.netlify/functions/mapping/lookup`);
      
      // Increased timeout for the fetch request
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      
      const response = await fetch(`${siteUrl}/.netlify/functions/mapping/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: formattedPhone }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        if (response.status === 404) {
          console.log(`No email mappings found for phone: ${formattedPhone}`);
          return [];
        }
        throw new Error(`Error looking up emails: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Handle both old and new response formats
      const emails = data.emails || (data.email ? [data.email] : []);
      return emails.filter(email => email && email.trim()); // Remove empty emails
    } catch (error) {
      console.error("Error with mapping function:", error);
      // If API call fails, we return empty array and use fallback contact
      return [];
    }
  } catch (error) {
    console.error("Error looking up emails:", error);
    return [];
  }
}

// Format phone number to E.164 format
function formatPhoneNumber(phone) {
  if (!phone) return null;
  
  // Remove all non-digit characters
  let digits = phone.replace(/\D/g, '');
  
  // Add country code if missing
  if (digits.length === 10) {
    digits = '1' + digits; // Assume US number
  }
  
  // Validate length (assuming international format)
  if (digits.length < 10 || digits.length > 15) {
    return null;
  }
  
  return '+' + digits;
}

// NEW: Find a contact in SalesNexus by trying multiple emails
async function findContactByEmails(emails) {
  if (!emails || emails.length === 0) {
    console.log("No emails provided");
    return null;
  }
  
  // Try each email until we find a contact
  for (const email of emails) {
    if (email && email.trim()) {
      console.log(`Trying to find contact with email: ${email.trim()}`);
      const contactId = await findContactByEmail(email.trim());
      if (contactId) {
        console.log(`Found contact with email ${email.trim()}: ${contactId}`);
        return contactId;
      }
    }
  }
  
  console.log(`No contact found for any of the emails: ${emails.join(', ')}`);
  return null;
}

// Find a contact in SalesNexus by email - IMPROVED ERROR HANDLING
async function findContactByEmail(email) {
  try {
    if (!email) {
      console.log("No email provided");
      return null;
    }
    
    console.log(`Searching for contact with email: ${email}`);
    
    // Get the API key
    const apiKey = process.env.SALESNEXUS_API_KEY;
    
    // Use the SalesNexus API to search for contacts by email
    const searchPayload = [{
      "function": "get-contacts",
      "parameters": {
        "login-token": apiKey,
        "filter-value": email, // Search by email
        "start-after": "0",
        "page-size": "10"
      }
    }];
    
    console.log("Sending search request to SalesNexus");
    
    // Make the API request
    const response = await fetch("https://logon.salesnexus.com/api/call-v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(searchPayload)
    });
    
    const result = await response.json();
    console.log("Search result from SalesNexus:", JSON.stringify(result));
    
    // Check if we got a valid response with contacts
    if (result && result[0] && result[0].result && result[0].result.success === "true" && result[0].result["contact-list"]) {
      const contactList = result[0].result["contact-list"];
      
      // Check if we have contact IDs
      if (contactList["contact-ids"] && contactList["contact-ids"].length > 0) {
        console.log(`Found ${contactList["contact-ids"].length} matching contacts for email: ${email}`);
        // Return the ID of the first matching contact
        return contactList["contact-ids"][0];
      }
      
      // Try another way to extract contact IDs
      if (contactList["total-record-count"] && parseInt(contactList["total-record-count"]) > 0) {
        console.log(`Found ${contactList["total-record-count"]} matching contacts for email: ${email}`);
        // Find the first contact ID
        const contactIds = Object.keys(contactList["contact-info"] || {});
        if (contactIds.length > 0) {
          console.log(`Using first contact ID for email ${email}: ${contactIds[0]}`);
          return contactIds[0];
        }
      }
    }
    
    console.log(`No matching contacts found for email: ${email}`);
    return null;
  } catch (error) {
    console.error(`Error searching for contact with email ${email}:`, error);
    return null;
  }
}

// Handle OpenPhone recording webhook
async function handleRecording(payload, contactId) {
  try {
    // Extract the recording details from the OpenPhone payload structure
    const callData = payload.data?.object || {};
    const mediaItems = callData.media || [];
    const recordingUrl = mediaItems.length > 0 ? mediaItems[0].url : "No recording URL available";
    
    const callDate = new Date(callData.createdAt || Date.now()).toLocaleString();
    const callDuration = mediaItems.length > 0 && mediaItems[0].duration ? 
      `${Math.round(mediaItems[0].duration / 60)} minutes` : "Unknown duration";
    const callerNumber = callData.from || "Unknown caller";
    const receiverNumber = callData.to || "Unknown receiver";
    const callId = callData.id || "";
    
    // Create the note details with the recording information
    const noteDetails = `
OpenPhone Call Recording - ${callDate}
-------------------------------------
From: ${callerNumber}
To: ${receiverNumber}
Duration: ${callDuration}
Recording: ${recordingUrl}

Direct link to call in OpenPhone: https://app.openphone.com/calls/${callId}
`;
    
    // Create the note in SalesNexus
    await createNote(contactId, noteDetails);
  } catch (error) {
    console.error("Error handling recording:", error);
    throw error;
  }
}

// Handle OpenPhone summary webhook
async function handleSummary(payload, contactId) {
  try {
    // Extract the summary details from the OpenPhone payload structure
    const summaryData = payload.data?.object || {};
    const summaryPoints = summaryData.summary || [];
    const nextSteps = summaryData.nextSteps || [];
    const callId = summaryData.callId || "";
    
    // Format the summary as a string
    let formattedSummary = "No summary available";
    if (summaryPoints.length > 0) {
      formattedSummary = "Summary:\n- " + summaryPoints.join("\n- ");
      
      if (nextSteps.length > 0) {
        formattedSummary += "\n\nNext Steps:\n- " + nextSteps.join("\n- ");
      }
    }
    
    const callDate = new Date(payload.createdAt || Date.now()).toLocaleString();
    
    // Create the note details with the summary information
    const noteDetails = `
OpenPhone Call Summary - ${callDate}
------------------------------------
${formattedSummary}

Direct link to call in OpenPhone: https://app.openphone.com/calls/${callId}
`;
    
    // Create the note in SalesNexus
    await createNote(contactId, noteDetails);
  } catch (error) {
    console.error("Error handling summary:", error);
    throw error;
  }
}

// Handle OpenPhone transcript webhook
async function handleTranscript(payload, contactId) {
  try {
    // Extract the transcript details from the OpenPhone payload structure
    const transcriptData = payload.data?.object || {};
    const dialogueSegments = transcriptData.dialogue || [];
    const callId = transcriptData.callId || "";
    
    // Format the transcript
    let formattedTranscript = "No transcript content";
    if (dialogueSegments.length > 0) {
      formattedTranscript = dialogueSegments
        .map(segment => {
          const speaker = segment.identifier || "Speaker";
          return `${speaker}: ${segment.content || ""}`;
        })
        .join("\n");
    }
    
    const callDate = new Date(transcriptData.createdAt || Date.now()).toLocaleString();
    
    // Create the note details with the transcript information
    const noteDetails = `
OpenPhone Call Transcript - ${callDate}
---------------------------------------
${formattedTranscript}

Direct link to call in OpenPhone: https://app.openphone.com/calls/${callId}
`;
    
    // Create the note in SalesNexus
    await createNote(contactId, noteDetails);
  } catch (error) {
    console.error("Error handling transcript:", error);
    throw error;
  }
}

// Function to create a note in SalesNexus - Updated based on SalesNexus API documentation
async function createNote(contactId, details) {
  try {
    // Use API key directly
    const apiKey = process.env.SALESNEXUS_API_KEY;
    
    // Define the note creation payload - correctly formatted per SalesNexus API docs
    const notePayload = [{
      "function": "create-note",
      "parameters": {
        "login-token": apiKey,
        "contact-id": contactId,
        "details": details,
        "type": 1  // Using 1 as a default numeric type code
      },
      "request-id": "openphone-webhook-" + Date.now()
    }];
    
    // Make the API request to SalesNexus
    const response = await fetch("https://logon.salesnexus.com/api/call-v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(notePayload)
    });
    
    const result = await response.json();
    console.log("Note creation result:", JSON.stringify(result));
    
    // Check for success in the result
    if (result && result[0] && result[0].result && result[0].result.success === "true") {
      console.log("Note created successfully");
      return result;
    } else if (result && result[0] && result[0].error) {
      throw new Error(`SalesNexus API error: ${result[0].error}`);
    } else {
      throw new Error("Unknown error creating note");
    }
  } catch (error) {
    console.error("Error creating note:", error);
    throw error;
  }
}
