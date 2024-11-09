import { type HandlerContext, type Config } from '@netlify/functions';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import hbs from 'nodemailer-express-handlebars';
import { type NodemailerExpressHandlebarsOptions } from 'nodemailer-express-handlebars';
import { type Options as MailOptions } from 'nodemailer/lib/smtp-transport';
import { create } from 'express-handlebars';
import path from 'path';
import dotenv from 'dotenv';

const FUNCTION_ENDPOINT = '/.netlify/functions/send-email';

const CONTACT_FORM_NAME = 'writeToMe';

const REDIRECT_URL_EN = './message-received';
const REDIRECT_URL_DA = './besked-modtaget/';

// Define the exact shape of your template context
interface EmailTemplateContext {
  first_name: string;
  siteURL: string;
  logo1: string;
  logo2: string;
  linkedIn: string;
  signature: string;
}

// Template options with strongly typed context
interface TemplateOptions {
  template: 'mailTemplateDa' | 'mailTemplateEn' | 'newMessage';
  context?: EmailTemplateContext;
}

type MailWithTemplateOptions = MailOptions & TemplateOptions;

// Create handlebars instance
const exphbs = create({
  extname: '.handlebars',
  defaultLayout: false,
});

// Configure handlebars options with correct typing
const handlebarsOptions: NodemailerExpressHandlebarsOptions = {
  viewEngine: exphbs,
  viewPath: path.resolve(__dirname, './'),
  extName: '.handlebars',
};

// Load environment variables during development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

// Zod Schemas
const EmailDataSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  subject: z.string().min(1, 'Subject is required'),
  language: z.enum(['en', 'da'], {
    errorMap: () => ({ message: "Language must be either 'en' or 'da'" }),
  }),
});

const PayloadSchema = z.object({
  first_name: z.string().min(1, 'First name is required'),
  body: z.string().min(1, 'Message body is required'),
  data: EmailDataSchema,
  form_name: z.string().min(1, 'Form name is required'),
  site_url: z.string().url('Invalid site URL'),
});

/** Mocking nodemailer.createTransport in local development testing */
const mockTransporter = {
  verify: async () => true,
  use: () => {},
  sendMail: async (options: MailWithTemplateOptions) => {
    console.info('Development mode: Email would be sent with:', options);
    return { messageId: 'mock-id' };
  },
};

export const handler = async (req: Request, _context: HandlerContext) => {
  // Enable CORS for local development
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  } as const;

  // Default to English redirect
  let redirectUrl = REDIRECT_URL_EN;

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers,
    };
  }

  if (req.method !== 'POST') {
    return {
      statusCode: 501,
      body: JSON.stringify({ message: 'Not Implemented' }),
      headers: { 'content-type': 'application/json' },
    };
  }

  try {
    const body = await req.json();
    if (!body) {
      return new Response(
        JSON.stringify({ error: 'No request body provided' }),
        {
          status: 400,
          headers,
        }
      );
    }

    const parseResult = PayloadSchema.safeParse(body.payload);

    if (!parseResult.success) {
      return new Response(
        JSON.stringify({
          error: 'Validation failed',
          details: parseResult.error.errors,
        }),
        {
          status: 400,
          headers,
        }
      );
    }

    const { data: payload } = parseResult;
    const {
      first_name,
      body: messageBody,
      data,
      form_name,
      site_url,
    } = payload;
    const {
      name: sender_name,
      email: sender_email,
      language: sender_language,
    } = data;

    // Set redirect URL based on language
    redirectUrl = sender_language === 'da' ? REDIRECT_URL_DA : REDIRECT_URL_EN;

    const cleanSiteUrl = site_url.replace(/^https?:\/\//, '');

    const createNodeMailerTransporter = () =>
      nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: {
          user: process.env.MAIL_USER,
          pass: process.env.MAIL_PASSWORD,
        },
      });

    const transporter =
      process.env.NODE_ENV === 'development'
        ? mockTransporter
        : createNodeMailerTransporter();

    if (process.env.NODE_ENV !== 'development') {
      transporter.verify(function (error, success) {
        if (error) {
          console.error(error);
        } else {
          console.info('Server is ready to take our messages:', success);
        }
      });
    }

    const template =
      sender_language === 'da' ? 'mailTemplateDa' : 'mailTemplateEn';
    const subject =
      sender_language === 'da'
        ? '🎈 Tak for din besked!'
        : '🎈 Thank you for your message!';

    // Only set up handlebars in production
    if (process.env.NODE_ENV !== 'development') {
      transporter.use('compile', hbs(handlebarsOptions));
    }

    if (form_name === CONTACT_FORM_NAME) {
      const mailConfirmationOptions: MailWithTemplateOptions = {
        from: `Lars 🍀 Ejaas <${process.env.NOREPLY_PRIVATE_EMAIL_USER}>`,
        to: `${sender_name} <${sender_email}>`,
        subject: subject,
        template: template,
        context: {
          first_name: first_name,
          siteURL: `https://${cleanSiteUrl}`,
          logo1: `https://${cleanSiteUrl}/logo1_email.png`,
          logo2: `https://${cleanSiteUrl}/logo2_email.png`,
          linkedIn: `https://${cleanSiteUrl}/linkedIn_email.png`,
          signature: `https://${cleanSiteUrl}/signature.png`,
        },
      };

      const mailNotificationOptions: MailWithTemplateOptions = {
        from: `${sender_name} <${sender_email}>`,
        to: process.env.PERSONAL_EMAIL_ADDRESS,
        subject: `${sender_name}`,
        template: 'newMessage',
        context: {
          first_name: first_name,
          siteURL: `https://${cleanSiteUrl}`,
          logo1: `https://${cleanSiteUrl}/logo1_email.png`,
          logo2: `https://${cleanSiteUrl}/logo2_email.png`,
          linkedIn: `https://${cleanSiteUrl}/linkedIn_email.png`,
          signature: `https://${cleanSiteUrl}/signature.png`,
        },
      };

      await Promise.all([
        // send confirmation email to sender
        transporter.sendMail(mailConfirmationOptions),
        // Notification email to receiver
        transporter.sendMail(mailNotificationOptions),
      ]);
    }

    return new Response(
      JSON.stringify({
        message: `Emails ${
          process.env.NODE_ENV === 'development' ? 'would be' : 'was'
        } sent successfully. Confirmation sent to ${sender_name} at ${sender_email}`,
      }),
      {
        status: 200,
        headers,
      }
    );
  } catch (error) {
    console.error('Error processing request:', error);
    return new Response(
      JSON.stringify({
        error: 'Internal server error',
        message:
          error instanceof Error ? error.message : 'Failed to send emails',
      }),
      {
        status: 500,
        headers: {
          ...headers,
          Location: redirectUrl,
        },
      }
    );
  }
};

export const config: Config = {
  path: FUNCTION_ENDPOINT,
};
