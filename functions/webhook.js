// functions/webhook.js

exports.handler = async function(event, context) {
  try {
    // Parse the webhook payload from OpenPhone
    const payload = JSON.parse(event.body);
    console.log("Received webhook from OpenPhone:", JSON.stringify(payload));

    // Extract phone numbers from the webhook
    let fromNumber = "";
    let toNumber = "";
    if (payload.data && payload.data.object) {
      // The "from" number is who's calling
      fromNumber = payload.data.object.from || "";
      
      // The "to" number is who was called
      toNumber = payload.data.object.to || "";
    }
    
    console.log(`Call from ${fromNumber} to ${toNumber}`);
    
    // Determine which phone number to use for contact matching
    // For outgoing calls (from your OpenPhone number), use the "to" number
    // For incoming calls (to your OpenPhone number), use the "from" number
    const direction = payload.data?.object?.direction || "outgoing";
    const phoneNumberForLookup = direction === "outgoing" ? toNumber : fromNumber;
    
    console.log(`Looking for contact with phone number: ${phoneNumberForLookup}`);
    
    // Find the contact matching this phone number
    let contactId = null;
    try {
      contactId = await findContactByPhoneNumber(phoneNumberForLookup);
    } catch (error) {
      console.error("Error finding contact:", error);
      contactId = process.env.FALLBACK_CONTACT_ID;
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

// Find a contact in SalesNexus by phone number
async function findContactByPhoneNumber(phoneNumber) {
  if (!phoneNumber) {
    console.log("No phone number provided for lookup");
    return process.env.FALLBACK_CONTACT_ID;
  }
  
  // Clean the phone number to ensure consistent format
  const cleanNumber = phoneNumber.replace(/\D/g, "");
  console.log(`Searching for contact with cleaned number: ${cleanNumber}`);
  
  try {
    // 1. Get all contacts (we'll do this in batches to handle large contact lists)
    const apiKey = process.env.SALESNEXUS_API_KEY;
    const batchSize = 100; // Number of contacts to get per request
    let foundContact = null;
    let startAfter = 0;
    
    while (!foundContact) {
      // Make the API request to get a batch of contacts
      const getContactsPayload = [{
        "function": "get-contacts",
        "parameters": {
          "login-token": apiKey,
          "filter-value": "", // Empty filter to get all contacts
          "start-after": startAfter.toString(),
          "page-size": batchSize.toString()
        }
      }];
      
      console.log(`Fetching contacts batch starting at ${startAfter}`);
      
      const response = await fetch("https://logon.salesnexus.com/api/call-v1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(getContactsPayload)
      });
      
      const result = await response.json();
      console.log(`Got batch of contacts, success: ${result[0].result?.success || 'false'}`);
      
      // Check if we got any contacts back
      if (!result[0].result || result[0].result.success !== "true" || !result[0].result["contact-list"]) {
        console.log("No more contacts found or API error");
        break; // Exit the loop if we've gone through all contacts or there's an error
      }
      
      // Parse the contact list
      const contactListStr = result[0].result["contact-list"];
      let contactList = [];
      try {
        contactList = JSON.parse(contactListStr);
      } catch (e) {
        console.error("Error parsing contact list:", e);
        break;
      }
      
      if (contactList.length === 0) {
        console.log("No more contacts found");
        break; // Exit the loop if we've gone through all contacts
      }
      
      console.log(`Processing ${contactList.length} contacts`);
      
      // For each contact, get their details and check their phone numbers
      for (const contact of contactList) {
        const contactId = contact.id;
        
        // Get all the data for this contact
        const getContactInfoPayload = [{
          "function": "get-contact-info",
          "parameters": {
            "login-token": apiKey,
            "contact-id": contactId
          }
        }];
        
        const infoResponse = await fetch("https://logon.salesnexus.com/api/call-v1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(getContactInfoPayload)
        });
        
        const infoResult = await infoResponse.json();
        
        // Check if we got the contact info
        if (infoResult[0].result && infoResult[0].result.success === "true" && infoResult[0].result["field-data"]) {
          // Parse the field data
          try {
            const fieldDataStr = infoResult[0].result["field-data"];
            const fieldData = JSON.parse(fieldDataStr);
            
            // Check all phone number fields (typical field IDs for phone numbers might be around 150, 151, 152, etc.)
            // We'll log the field IDs and values to help identify which fields contain phone numbers
            console.log(`Checking contact ${contactId} field data`);
            
            // Loop through all fields in the contact
            for (const fieldId in fieldData) {
              const fieldValue = fieldData[fieldId];
              
              // Skip empty values
              if (!fieldValue) continue;
              
              // Log any field that looks like a phone number
              if (typeof fieldValue === 'string' && fieldValue.match(/\d{10}|\d{7}|\+\d{11}|\(\d{3}\)/)) {
                console.log(`Field ${fieldId} has possible phone value: ${fieldValue}`);
                
                // Clean the field value to compare with our search number
                const cleanFieldValue = fieldValue.replace(/\D/g, "");
                
                // Check if this field matches our search phone number
                if (cleanFieldValue.includes(cleanNumber) || cleanNumber.includes(cleanFieldValue)) {
                  console.log(`Found matching contact! ID: ${contactId}`);
                  foundContact = contactId;
                  break; // Exit the loop once we find a match
                }
              }
            }
          } catch (e) {
            console.error(`Error parsing field data for contact ${contactId}:`, e);
          }
        }
        
        // Exit the loop if we found a matching contact
        if (foundContact) break;
      }
      
      // Exit the loop if we found a matching contact
      if (foundContact) break;
      
      // Move to the next batch of contacts
      startAfter += batchSize;
      
      // Safety check to prevent infinite loops
      if (startAfter > 1000) {
        console.log("Reached maximum contacts to check (1000), stopping search");
        break;
      }
    }
    
    // Return the found contact ID or the fallback ID
    return foundContact || process.env.FALLBACK_CONTACT_ID;
  } catch (error) {
    console.error("Error searching for contact:", error);
    return process.env.FALLBACK_CONTACT_ID;
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
    
    // Format the summary as a string
    let formattedSummary = "No summary available";
    if (summaryPoints.length > 0) {
      formattedSummary = "Summary:\n- " + summaryPoints.join("\n- ");
      
      if (nextSteps.length > 0) {
        formattedSummary += "\n\nNext Steps:\n- " + nextSteps.join("\n- ");
      }
    }
    
    const callDate = new Date(payload.createdAt || Date.now()).toLocaleString();
    const callId = summaryData.callId || "";
    
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
    const callId = transcriptData.callId || "";
    
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

// Function to create a note in SalesNexus
async function createNote(contactId, details) {
  try {
    // Use API key directly
    const apiKey = process.env.SALESNEXUS_API_KEY;
    
    // Define the note creation payload
    const notePayload = [{
      "function": "create-note",
      "parameters": {
        "login-token": apiKey,
        "contact-id": contactId,
        "details": details,
        "type": 1  // Using 1 as a default numeric type code
      }
    }];
    
    // Make the API request to SalesNexus
    const response = await fetch("https://logon.salesnexus.com/api/call-v1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(notePayload)
    });
    
    const result = await response.json();
    console.log("Note creation result:", JSON.stringify(result));
    
    // Check for any errors in the response
    if (result[0].error) {
      throw new Error(`SalesNexus API error: ${result[0].error}`);
    }
    
    return result;
  } catch (error) {
    console.error("Error creating note:", error);
    throw error;
  }
}
