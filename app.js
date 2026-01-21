require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Airtable = require('airtable');
const { Resend } = require('resend');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

// Initialize Anthropic client for AI chat
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Resend for magic link emails (optional - for production)
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// In-memory token store (in production, use Redis or database)
const magicLinkTokens = new Map();

// Session duration: 6 months in milliseconds
const SESSION_DURATION_MS = 6 * 30 * 24 * 60 * 60 * 1000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Health check endpoint (no dependencies)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    port: PORT,
    hasAirtable: !!(process.env.AIRTABLE_PAT && process.env.AIRTABLE_BASE_ID)
  });
});

// Log environment status on startup
console.log('Environment check:', {
  PORT,
  hasAirtablePat: !!process.env.AIRTABLE_PAT,
  hasAirtableBaseId: !!process.env.AIRTABLE_BASE_ID,
  hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
  hasResendKey: !!process.env.RESEND_API_KEY
});

// Airtable setup
const base = new Airtable({ apiKey: process.env.AIRTABLE_PAT }).base(process.env.AIRTABLE_BASE_ID);

/**
 * Fetch a mentor by their Airtable record ID
 */
async function getMentorById(mentorId) {
  try {
    const record = await base('Mentors').find(mentorId);
    return {
      id: record.id,
      name: record.get('Name'),
      ...record.fields
    };
  } catch (err) {
    console.error(`Error fetching mentor ${mentorId}:`, err.message);
    return null;
  }
}

/**
 * Fetch a meeting by its Airtable record ID and hydrate mentor info
 */
async function getMeetingById(meetingId) {
  try {
    const record = await base('Student-Mentor Meetings').find(meetingId);
    const meeting = {
      id: record.id,
      ...record.fields
    };

    // Hydrate the mentor who attended
    const mentorIds = meeting['Mentors Attended'];
    if (mentorIds && mentorIds.length > 0) {
      const mentor = await getMentorById(mentorIds[0]);
      if (mentor) {
        meeting.mentorAttended = mentor;
      }
    }

    return meeting;
  } catch (err) {
    console.error(`Error fetching meeting ${meetingId}:`, err.message);
    return null;
  }
}

/**
 * Hydrate a student record with linked mentor data
 */
async function hydrateStudent(record) {
  const student = {
    id: record.id,
    ...record.fields
  };

  // Hydrate Recruitment Manager
  const recruitmentManagerIds = student['Recruitment Manager'];
  if (recruitmentManagerIds && recruitmentManagerIds.length > 0) {
    const recruitmentManager = await getMentorById(recruitmentManagerIds[0]);
    if (recruitmentManager) {
      student.recruitmentManager = recruitmentManager;
    }
  }

  // Hydrate Lead Mentor
  const leadMentorIds = student['Lead Mentor'];
  if (leadMentorIds && leadMentorIds.length > 0) {
    const leadMentor = await getMentorById(leadMentorIds[0]);
    if (leadMentor) {
      student.leadMentor = leadMentor;
    }
  }

  // Hydrate Student-Mentor Meetings
  const meetingIds = student['Student-Mentor Meetings'];
  if (meetingIds && meetingIds.length > 0) {
    const meetings = await Promise.all(
      meetingIds.map(id => getMeetingById(id))
    );
    student.meetings = meetings.filter(m => m !== null);
  } else {
    student.meetings = [];
  }

  return student;
}

/**
 * Find a student by email and return hydrated profile
 */
async function getStudentByEmail(email) {
  try {
    const records = await base('Students')
      .select({
        filterByFormula: `{Student's Email} = '${email}'`,
        maxRecords: 1
      })
      .firstPage();

    if (records.length === 0) {
      return null;
    }

    return await hydrateStudent(records[0]);
  } catch (err) {
    console.error(`Error fetching student by email:`, err.message);
    throw err;
  }
}

// Routes

// Request magic link - sends email with login link
app.post('/api/auth/magic-link', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if student exists in Airtable
    const records = await base('Students')
      .select({
        filterByFormula: `{Student's Email} = '${normalizedEmail}'`,
        maxRecords: 1
      })
      .firstPage();

    if (records.length === 0) {
      return res.status(404).json({ error: 'No student found with this email' });
    }

    const student = records[0];
    const firstName = student.get('Preferred First Name') || student.get('Name')?.split(' ')[0] || 'there';

    // Generate magic link token
    const token = uuidv4();
    const expiresAt = Date.now() + 15 * 60 * 1000; // Token expires in 15 minutes

    // Store token
    magicLinkTokens.set(token, {
      email: normalizedEmail,
      expiresAt
    });

    // Build magic link URL
    const baseUrl = process.env.APP_URL || `http://localhost:${PORT}`;
    const magicLink = `${baseUrl}?token=${token}`;

    // If Resend is configured, send email
    if (resend) {
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'WSG Portal <noreply@resend.dev>',
        to: normalizedEmail,
        subject: 'Sign in to WSG Student Portal',
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
            <h2 style="color: #0a1628; margin-bottom: 24px;">Hi ${firstName}!</h2>
            <p style="color: #525252; font-size: 16px; line-height: 1.6;">
              Click the button below to sign in to your WSG Student Portal. This link will expire in 15 minutes.
            </p>
            <a href="${magicLink}" style="display: inline-block; background: #0a1628; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 500; margin: 24px 0;">
              Sign In to Portal
            </a>
            <p style="color: #a3a3a3; font-size: 14px; margin-top: 32px;">
              If you didn't request this email, you can safely ignore it.
            </p>
          </div>
        `
      });
      res.json({ success: true, message: 'Magic link sent to your email' });
    } else {
      // Development mode: return the magic link directly
      console.log(`\n✨ Magic link for ${normalizedEmail}:\n${magicLink}\n`);
      res.json({
        success: true,
        message: 'Magic link generated',
        devMode: true,
        magicLink
      });
    }

  } catch (err) {
    console.error('Magic link error:', err.message);
    res.status(500).json({ error: 'Failed to send magic link', details: err.message });
  }
});

// Dev login bypass (only works in dev mode)
app.post('/api/auth/dev-login', async (req, res) => {
  try {
    // Only allow when DEV_MODE is enabled
    if (process.env.DEV_MODE !== 'true') {
      return res.status(403).json({ error: 'Dev login not available in production' });
    }

    const { email } = req.body;
    const testEmail = email || process.env.DEV_TEST_EMAIL || 'test@example.com';
    const normalizedEmail = testEmail.toLowerCase().trim();

    // Check if student exists
    const records = await base('Students')
      .select({
        filterByFormula: `{Student's Email} = '${normalizedEmail}'`,
        maxRecords: 1
      })
      .firstPage();

    if (records.length === 0) {
      return res.status(404).json({ error: `No student found with email: ${normalizedEmail}` });
    }

    const student = records[0];

    // Generate session token directly
    const sessionToken = uuidv4();
    const sessionExpiresAt = Date.now() + SESSION_DURATION_MS;

    console.log(`\n🔓 Dev login for: ${normalizedEmail}\n`);

    res.json({
      success: true,
      session: {
        token: sessionToken,
        expiresAt: sessionExpiresAt
      },
      student: {
        id: student.id,
        email: student.get("Student's Email"),
        name: student.get('Name') || student.get('Student ID'),
        firstName: student.get('Preferred First Name')
      }
    });

  } catch (err) {
    console.error('Dev login error:', err.message);
    res.status(500).json({ error: 'Dev login failed', details: err.message });
  }
});

// Verify magic link token
app.post('/api/auth/verify', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    // Look up token
    const tokenData = magicLinkTokens.get(token);

    if (!tokenData) {
      return res.status(401).json({ error: 'Invalid or expired link' });
    }

    // Check if expired
    if (Date.now() > tokenData.expiresAt) {
      magicLinkTokens.delete(token);
      return res.status(401).json({ error: 'Link has expired. Please request a new one.' });
    }

    // Token is valid - delete it (one-time use)
    magicLinkTokens.delete(token);

    // Get student data
    const records = await base('Students')
      .select({
        filterByFormula: `{Student's Email} = '${tokenData.email}'`,
        maxRecords: 1
      })
      .firstPage();

    if (records.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const student = records[0];

    // Generate session token
    const sessionToken = uuidv4();
    const sessionExpiresAt = Date.now() + SESSION_DURATION_MS;

    res.json({
      success: true,
      session: {
        token: sessionToken,
        expiresAt: sessionExpiresAt
      },
      student: {
        id: student.id,
        email: student.get("Student's Email"),
        name: student.get('Name') || student.get('Student ID'),
        firstName: student.get('Preferred First Name')
      }
    });

  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ error: 'Verification failed', details: err.message });
  }
});

// AI Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    if (!anthropic) {
      return res.status(503).json({ error: 'AI service not configured. Please add ANTHROPIC_API_KEY to .env' });
    }

    const { message, studentContext, conversationHistory } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Build the system prompt with student context
    const systemPrompt = `You are the WSG AI Recruitment Expert, a knowledgeable and supportive advisor for students pursuing careers in finance and consulting. You have deep expertise in:

- Investment banking (IBD) recruiting, technicals, and interviews
- Management consulting recruiting and case interviews
- Private equity and venture capital
- Sales & trading and research
- Corporate finance and FP&A

Your role is to:
1. Give clear, constructive feedback that helps students improve
2. Push students to develop their own interview skills rather than just giving answers
3. Use the Socratic method when appropriate - ask guiding questions
4. Be encouraging but honest about areas for improvement
5. Provide specific, actionable advice

${studentContext ? `
STUDENT CONTEXT (use this to personalize your advice):
- Name: ${studentContext.name || 'Unknown'}
- University: ${studentContext.university || 'Unknown'}
- Graduation Year: ${studentContext.gradYear || 'Unknown'}
- Major: ${studentContext.major || 'Unknown'}
- Industry Interest: ${studentContext.industryInterest || 'Unknown'}
- Dream Company: ${studentContext.dreamCompany || 'Unknown'}
- Career Goals: ${studentContext.goals || 'Unknown'}
` : ''}

Guidelines:
- Keep responses concise but thorough (aim for 2-4 paragraphs unless more detail is needed)
- Use bullet points and structure for complex topics
- When doing mock interviews or cases, simulate realistic scenarios
- If a student asks you to solve a case or answer a technical question, first ask them to try, then provide feedback
- Be warm and personable, but professional
- Reference the student's specific situation and goals when relevant`;

    // Build messages array with conversation history
    const messages = [];

    if (conversationHistory && conversationHistory.length > 0) {
      messages.push(...conversationHistory);
    }

    messages.push({ role: 'user', content: message });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages
    });

    const assistantMessage = response.content[0].text;

    res.json({
      success: true,
      message: assistantMessage
    });

  } catch (err) {
    console.error('AI Chat error:', err.message);
    res.status(500).json({ error: 'Failed to get AI response', details: err.message });
  }
});

// Get all active mentors for the Find a Mentor feature
app.get('/api/mentors', async (req, res) => {
  try {
    const records = await base('Mentors')
      .select({
        filterByFormula: `{Mentor Active Status} = 'Active'`,
        sort: [{ field: 'Name', direction: 'asc' }]
      })
      .all();

    const mentors = records.map(record => ({
      id: record.id,
      name: record.get('Name'),
      headshot: record.get('Headshot'),
      company: record.get('Current/Upcoming Company'),
      jobTitle: record.get('Job Title'),
      industry: record.get('Industry/Sector & Group'),
      education: record.get('Education'),
      degree: record.get('Degree'),
      graduationYear: record.get('Graduation Year'),
      location: record.get('Location'),
      type: record.get('Type of Mentor'),
      linkedin: record.get('LinkedIn'),
      skills: record.get('Skills'),
      intro: record.get('Mentor Intro') || record.get('AI Mentor Intro')?.value,
      previousExperience: record.get('Previous Experience'),
      otherOffers: record.get('What other offers did you receive?')
    }));

    res.json({ mentors });
  } catch (err) {
    console.error('Error fetching mentors:', err.message);
    res.status(500).json({ error: 'Failed to fetch mentors', details: err.message });
  }
});

app.get('/student/:email', async (req, res) => {
  try {
    const email = req.params.email;
    const student = await getStudentByEmail(email);

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    res.json(student);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch student', details: err.message });
  }
});

// Update student profile
app.post('/api/student/update', async (req, res) => {
  try {
    const { email, updates } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'Updates object is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find the student record
    const records = await base('Students')
      .select({
        filterByFormula: `{Student's Email} = '${normalizedEmail}'`,
        maxRecords: 1
      })
      .firstPage();

    if (records.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const studentRecord = records[0];

    // Filter out null/undefined values and empty strings for optional fields
    const fieldsToUpdate = {};
    const allowedFields = [
      'Current University / Institution',
      'Degree / Major',
      'Graduation Year',
      'GPA',
      'Current Clubs / Extracurriculars',
      'CV/Resume',
      'Short-Term Goals (1-3 Years)',
      'What countries do you own a passport?'
    ];

    for (const field of allowedFields) {
      if (field in updates) {
        const value = updates[field];
        // Only include non-null values (allow 0 for numbers, empty string clears text fields)
        if (value !== null && value !== undefined) {
          fieldsToUpdate[field] = value;
        }
      }
    }

    // Update the record in Airtable
    const updatedRecord = await base('Students').update(studentRecord.id, fieldsToUpdate);

    // Return the updated student data
    const updatedStudent = await hydrateStudent(updatedRecord);

    res.json({
      success: true,
      student: updatedStudent
    });

  } catch (err) {
    console.error('Student update error:', err.message);
    res.status(500).json({ error: 'Failed to update student profile', details: err.message });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`WSG Portal API running on port ${PORT}`);
});
