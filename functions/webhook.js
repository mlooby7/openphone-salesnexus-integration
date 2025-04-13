// functions/webhook.js
const axios = require('axios');

exports.handler = async function(event, context) {
  console.log('Webhook function invoked');
  
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    console.log('Received non-POST request, returning 405');
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // Parse the OpenPhone webhook payload
    const payload = JSON.parse(event.body);
    console.log('Received webhook from OpenPhone:', payload);
    
    // Get event type
    const eventType = payload.type;
    console.log('Event type:', eventType);
    
    // Different handling based on event type
    let phoneNumber, callId, noteType, noteDetails;
    
    if (eventType === 'call.recording.completed') {
      // Handle call recordings
      const callData = payload.data.object;
      phoneNumber = callData.direction === 'incoming' ? callData.from : callData.to;
      callId = callData.id;
      
      noteType = "Recording";
      noteDetails = `Call Recording from ${phoneNumber}\n\n` +
                   `Date/Time: ${new Date(callData.createdAt).toLocaleString()}\n` +
                   `Direction: ${callData.direction === 'incoming' ? 'Inbound' : 'Outbound'}\n` +
                   `Duration: ${callData.media[0].duration || 0} seconds\n\n` +
                   `Recording URL: ${callData.media[0].url}\n\n` +
                   `OpenPhone Links:\n` +
                   `- Contact: https://app.openphone.com/contacts/${phoneNumber}\n` +
                   `- Call: https://app.openphone.com/calls/${callId}`;
    }
    else if (eventType === 'call.summary.completed') {
      // Handle call summaries
      const summaryData = payload.data.object;
      callId = summaryData.callId;
      
      // We need to fetch the call details to get the phone number
      console.log('Need to fetch call details for call ID:', callId);
      
      // For now, use a fallback contact
      phoneNumber = null;
      
      noteType = "Summary";
      let summaryText = '';
      if (summaryData.summary && Array.isArray(summaryData.summary)) {
        summaryText = summaryData.summary.join('\n');
      }
      
      noteDetails = `Call Summary\n\n` +
                   `Call ID: ${callId}\n\n` +
                   `Summary: ${summaryText}\n\n` +
                   `OpenPhone Links:\n` +
                   `- Call: https://app.openphone.com/calls/${callId}`;
    }
    else if (eventType === 'call.transcript.completed') {
      // Handle call transcripts
      const transcriptData = payload.data.object;
      callId = transcriptData.callId;
      
      // We need to fetch the call details to get the phone number
      console.log('Need to fetch call details for call ID:', callId);
      
      // For now, use a fallback contact
      phoneNumber = null;
      
      noteType = "Transcript";
      let transcriptText = '';
      if (transcriptData.dialogue && Array.isArray(transcriptData.dialogue)) {
        transcriptText = transcriptData.dialogue.map(d => `${d.speaker}: ${d.text}`).join('\n');
      }
      
      noteDetails = `Call Transcript\n\n` +
                   `Call ID: ${callId}\n` +
                   `Duration: ${transcriptData.duration || 0} seconds\n\n` +
                   `Transcript:\n${transcriptText}\n\n` +
                   `OpenPhone Links:\n` +
                   `- Call: https://app.openphone.com/calls/${callId}`;
    }
    else {
      console.log('Unsupported event type:', eventType);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: "Unsupported event type" })
      };
    }
    
    // Clean the phone number (remove non-numeric chars except leading +)
    let formattedPhoneNumber = null;
    if (phoneNumber) {
      if (phoneNumber.startsWith('+')) {
        formattedPhoneNumber = '+' + phoneNumber.substring(1).replace(/\D/g, '');
      } else {
        formattedPhoneNumber = phoneNumber.replace(/\D/g, '');
      }
      console.log(`Original phone: ${phoneNumber}, Formatted phone: ${formattedPhoneNumber}`);
    }
    
    // Use SalesNexus API key as login token
    const apiKey = process.env.SALESNEXUS_API_KEY;
    if (!apiKey) {
      throw new Error('SALESNEXUS_API_KEY environment variable is not set');
    }
    console.log('API Key is set');
    
    // Find contact ID if we have a phone number
    let contactId = null;
    
    if (formattedPhoneNumber) {
      // Try multiple phone formats for searching
      const phoneFormats = [
        formattedPhoneNumber,
        formattedPhoneNumber.replace(/^\+1/, ''),  // Without country code
        formattedPhoneNumber.replace(/^\+/, '')    // No plus sign
      ];
      
      // Try each phone format
      for (const phoneFormat of phoneFormats) {
        console.log(`Trying phone format: ${phoneFormat}`);
        
        // Search for contacts with this phone number
        const searchResponse = await axios.post('https://logon.salesnexus.com/api/call-v1', [{
          "function": "get-contacts",
          "parameters": {
            "login-token": apiKey, // Note: Using login-token parameter, not api-key!
            "filter-field": "35",
            "filter-value": phoneFormat,
            "start-after": "0",
            "page-size": "50"
          }
        }]);
        
        // Check if we found matching contacts
        if (searchResponse.data[0].result && 
            searchResponse.data[0].result['contact-list'] && 
            searchResponse.data[0].result['contact-list'].length > 0) {
          // Use the first matching contact
          contactId = searchResponse.data[0].result['contact-list'][0]['contact-id'];
          console.log(`Found matching contact with ID: ${contactId}`);
          break;
        }
      }
    }
    
    // If no contact found with any phone format, use fallback
    if (!contactId) {
      contactId = process.env.FALLBACK_CONTACT_ID;
      if (!contactId) {
        throw new Error('FALLBACK_CONTACT_ID environment variable is not set');
      }
      console.log(`No matching contact found. Using fallback ID: ${contactId}`);
    }
    
    // Create note in SalesNexus
    console.log('Creating note in SalesNexus');
    const noteResponse = await axios.post('https://logon.salesnexus.com/api/call-v1', [{
      "function": "create-note",
      "parameters": {
        "login-token": apiKey, // Note: Using login-token parameter, not api-key!
        "contact-id": contactId,
        "details": noteDetails,
        "type": "1"
      }
    }]);
    
    console.log('Note creation response:', noteResponse.data);
    
    // Return success response
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Successfully processed OpenPhone webhook",
        contactId: contactId,
        noteType: noteType
      })
    };
  } catch (error) {
    console.error('Error processing webhook:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: "Error processing webhook",
        details: error.message
      })
    };
  }
};
