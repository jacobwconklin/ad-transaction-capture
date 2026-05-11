import swaggerJsdoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Google Ads Webhook API',
      version: '1.0.0',
      description:
        'Receives Authorize.net payment webhooks, persists transactions, and uploads conversions to Google Ads.',
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
        hmacSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'X-ANET-Signature',
          description: 'HMAC-SHA512 signature provided by Authorize.net',
        },
      },
    },
  },
  apis: ['./index.js', './routes/*.js'],
};

export default swaggerJsdoc(options);
