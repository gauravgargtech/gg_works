#include <Trade\Trade.mqh>

input string NodeJS_IP      = "172.31.3.112";
input int    NodeJS_Port    = 3000;
input int    MagicNumber    = 12345;
input int    TP1_Pips       = 10;
input int    TP2_Pips       = 20;
input int    TP3_Pips       = 30;
input int    SL_Pips        = 40;
input int    PollSeconds    = 2;
input double LotSize        = 0.02;

// --- Balance reporter inputs ---
input string Balance_API_URL = "https://mumbr.xyz/balance";
input string Balance_API_Key = "-------------------------------------------------------";
input int    Balance_Hours   = 4;  // How often to send balance (hours)

CTrade trade;
string Symbols[] = {"AUDUSD.", "EURUSD.", "USDCAD.", "AUDNZD.", "GBPUSD.", "USDJPY.","NZDUSD."};
string Symbol1   = "";

// --- Balance reporter state ---
datetime g_lastBalanceSent = 0;

//+------------------------------------------------------------------+
void OnInit()
  {
   Print("=== NodeBridge Multi started ===");
   Print("Polling: ", NodeJS_IP, ":", NodeJS_Port);
   Print("Symbols: AUDUSD. EURUSD. USDCAD. AUDNZD. GBPUSD.");
   Print("Leg1 — vol: ", LotSize, " | TP: ", TP1_Pips, " pips | SL: ", SL_Pips, " pips");
   Print("Leg2 — vol: ", LotSize, " | TP: ", TP2_Pips, " pips | SL: ", SL_Pips, " pips");
   Print("Leg3 — vol: ", LotSize, " | TP: ", TP3_Pips, " pips | SL: ", SL_Pips, " pips");
   Print("Leg4 — vol: ", LotSize, " | TP: none        | SL: ", SL_Pips, " pips");
   Print("Balance reporter: every ", Balance_Hours, " hours → ", Balance_API_URL);
   EventSetTimer(PollSeconds);

   // Send immediately on startup so you get a reading right away
   SendBalance();
   g_lastBalanceSent = TimeCurrent();
  }

//+------------------------------------------------------------------+
void OnTimer()
  {
   // --- Balance reporter check (runs every PollSeconds tick) ---
   datetime now = TimeCurrent();
   if(now - g_lastBalanceSent >= Balance_Hours * 60 * 60)
     {
      SendBalance();
      g_lastBalanceSent = now;
     }

   // --- Existing symbol polling ---
   for(int i = 0; i < ArraySize(Symbols); i++)
     {
      Symbol1 = Symbols[i];
      PollNodeJS();
     }
  }

//+------------------------------------------------------------------+
// Balance reporter — sends account balance + equity to your Hono API
//+------------------------------------------------------------------+
void SendBalance()
  {
   string payload = StringFormat(
      "{\"account\":\"%d\",\"balance\":%.2f,\"equity\":%.2f,\"currency\":\"%s\"}",
      (int)AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoString(ACCOUNT_CURRENCY)
   );

   // Parse host and path from Balance_API_URL
   // Expects format: https://host/path
   string url  = Balance_API_URL;
   string host = "";
   string path = "/balance";

   // Strip https:// or http://
   int schemeEnd = StringFind(url, "://");
   if(schemeEnd >= 0) url = StringSubstr(url, schemeEnd + 3);

   // Split host from path
   int slashPos = StringFind(url, "/");
   if(slashPos >= 0)
     {
      host = StringSubstr(url, 0, slashPos);
      path = StringSubstr(url, slashPos);
     }
   else
     {
      host = url;
      path = "/balance";
     }

   int socket = SocketCreate();
   if(socket == INVALID_HANDLE)
     {
      Print("SendBalance: socket create failed: ", GetLastError());
      return;
     }

   if(!SocketConnect(socket, host, 443, 5000))
     {
      Print("SendBalance: connect failed to ", host);
      SocketClose(socket);
      return;
     }

   // TLS handshake for HTTPS
   if(!SocketTlsHandshake(socket, host))
     {
      Print("SendBalance: TLS handshake failed");
      SocketClose(socket);
      return;
     }

   string request = "POST " + path + " HTTP/1.1\r\n"
                    + "Host: " + host + "\r\n"
                    + "Content-Type: application/json\r\n"
                    + "x-api-key: " + Balance_API_Key + "\r\n"
                    + "Content-Length: " + IntegerToString(StringLen(payload)) + "\r\n"
                    + "Connection: close\r\n\r\n"
                    + payload;

   uchar reqBytes[];
   StringToCharArray(request, reqBytes, 0, StringLen(request));
   SocketTlsSend(socket, reqBytes, ArraySize(reqBytes));

   string fullResponse = "";
   uchar chunk[];
   ArrayResize(chunk, 512);
   while(SocketIsConnected(socket))
     {
      uint bytesRead = SocketTlsRead(socket, chunk, ArraySize(chunk));
      if(bytesRead == 0) break;
      fullResponse += CharArrayToString(chunk, 0, bytesRead);
     }

   SocketClose(socket);

   if(StringFind(fullResponse, "200") >= 0 || StringFind(fullResponse, "\"ok\"") >= 0)
      Print("SendBalance OK — balance: ", AccountInfoDouble(ACCOUNT_BALANCE),
            " equity: ", AccountInfoDouble(ACCOUNT_EQUITY));
   else
      Print("SendBalance failed — response: ", fullResponse);
  }

//+------------------------------------------------------------------+
string HttpGet(string path)
  {
   int socket = SocketCreate();
   if(socket == INVALID_HANDLE)
     {
      Print("HttpGet: socket create failed: ", GetLastError());
      return "";
     }

   if(!SocketConnect(socket, NodeJS_IP, NodeJS_Port, 3000))
     {
      SocketClose(socket);
      return "";
     }

   string request = "GET " + path + " HTTP/1.1\r\n"
                    + "Host: " + NodeJS_IP + ":" + IntegerToString(NodeJS_Port) + "\r\n"
                    + "Accept: application/json\r\n"
                    + "Connection: close\r\n\r\n";

   uchar reqBytes[];
   StringToCharArray(request, reqBytes, 0, StringLen(request));
   SocketSend(socket, reqBytes, ArraySize(reqBytes));

   string fullResponse = "";
   uchar chunk[];
   ArrayResize(chunk, 1024);

   while(SocketIsConnected(socket))
     {
      uint bytesRead = SocketRead(socket, chunk, ArraySize(chunk), 3000);
      if(bytesRead == 0) break;
      fullResponse += CharArrayToString(chunk, 0, bytesRead);
     }

   SocketClose(socket);
   return fullResponse;
  }

//+------------------------------------------------------------------+
string HttpPost(string path, string body)
  {
   int socket = SocketCreate();
   if(socket == INVALID_HANDLE)
     {
      Print("HttpPost: socket create failed: ", GetLastError());
      return "";
     }

   if(!SocketConnect(socket, NodeJS_IP, NodeJS_Port, 3000))
     {
      Print("HttpPost: connect failed");
      SocketClose(socket);
      return "";
     }

   string request = "POST " + path + " HTTP/1.1\r\n"
                    + "Host: " + NodeJS_IP + ":" + IntegerToString(NodeJS_Port) + "\r\n"
                    + "Content-Type: application/json\r\n"
                    + "Content-Length: " + IntegerToString(StringLen(body)) + "\r\n"
                    + "Connection: close\r\n\r\n"
                    + body;

   uchar reqBytes[];
   StringToCharArray(request, reqBytes, 0, StringLen(request));
   SocketSend(socket, reqBytes, ArraySize(reqBytes));

   string fullResponse = "";
   uchar chunk[];
   ArrayResize(chunk, 512);

   while(SocketIsConnected(socket))
     {
      uint bytesRead = SocketRead(socket, chunk, ArraySize(chunk), 2000);
      if(bytesRead == 0) break;
      fullResponse += CharArrayToString(chunk, 0, bytesRead);
     }

   SocketClose(socket);
   return fullResponse;
  }

//+------------------------------------------------------------------+
string ExtractBody(string response)
  {
   int bodyStart = StringFind(response, "\r\n\r\n");
   if(bodyStart < 0) return "";
   string body = StringSubstr(response, bodyStart + 4);

   string headers = StringSubstr(response, 0, bodyStart);
   bool isChunked = (StringFind(headers, "Transfer-Encoding: chunked") >= 0
                     || StringFind(headers, "transfer-encoding: chunked") >= 0);

   if(isChunked)
     {
      string decoded = "";
      int pos = 0;
      while(pos < StringLen(body))
        {
         int crlf = StringFind(body, "\r\n", pos);
         if(crlf < 0) break;
         string hexSize = StringSubstr(body, pos, crlf - pos);
         StringTrimLeft(hexSize);
         StringTrimRight(hexSize);
         if(hexSize == "" || hexSize == "0") break;

         int chunkSize = (int)StringToInteger("0x" + hexSize);
         if(chunkSize <= 0) break;

         pos = crlf + 2;
         decoded += StringSubstr(body, pos, chunkSize);
         pos += chunkSize + 2;
        }
      return decoded;
     }

   StringTrimLeft(body);
   StringTrimRight(body);
   return body;
  }

//+------------------------------------------------------------------+
void PollNodeJS()
  {
   string path = "/mt5/command?symbol=" + Symbol1;
   string response = HttpGet(path);
   if(response == "") return;

   string body = ExtractBody(response);
   StringTrimLeft(body);
   StringTrimRight(body);

   if(body == "") return;

   Print("Command body [", Symbol1, "]: ", body);
   ProcessCommand(body);
  }

//+------------------------------------------------------------------+
void ProcessCommand(string body)
  {
   if(StringFind(body, "\"action\":\"open\"") >= 0)
     {
      if(CountPositions() > 0)
        {
         Print("Already have open positions on ", Symbol1, " — skipping open");
         AckCommand();
         return;
        }
      string dir = (StringFind(body, "\"sell\"") >= 0) ? "sell" : "buy";
      Print("Opening legs direction: ", dir, " on ", Symbol1);
      OpenLegs(dir);
      AckCommand();
     }
   else if(StringFind(body, "\"action\":\"replace\"") >= 0)
     {
      string dir = (StringFind(body, "\"sell\"") >= 0) ? "sell" : "buy";
      if(CountPositions() > 0)
        {
         Print("Replace — closing existing positions first on ", Symbol1);
         CloseAllPositions();
         Sleep(1500);
        }
      Print("Replace — opening new legs: ", dir, " on ", Symbol1);
      OpenLegs(dir);
      AckCommand();
     }
   else if(StringFind(body, "\"action\":\"closeall\"") >= 0)
     {
      Print("Closing all positions on ", Symbol1);
      CloseAllPositions();
      AckCommand();
     }
   else if(StringFind(body, "\"action\":\"none\"") >= 0)
     {
      // No command — do nothing
     }
   else
     {
      Print("ProcessCommand: unrecognised body — ", body);
     }
  }

//+------------------------------------------------------------------+
void AckCommand()
  {
   string ackBody = "{\"symbol\":\"" + Symbol1 + "\"}";
   string response = HttpPost("/mt5/ack", ackBody);
   if(response == "")
      Print("AckCommand: no response from server");
   else
      Print("AckCommand sent OK for ", Symbol1);
  }

//+------------------------------------------------------------------+
void OpenLegs(string direction)
  {
   ENUM_ORDER_TYPE orderType = (direction == "buy")
                               ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;

   double ask     = SymbolInfoDouble(Symbol1, SYMBOL_ASK);
   double bid     = SymbolInfoDouble(Symbol1, SYMBOL_BID);
   double point   = SymbolInfoDouble(Symbol1, SYMBOL_POINT);
   int    digits  = (int)SymbolInfoInteger(Symbol1, SYMBOL_DIGITS);
   double pipSize = (digits == 5 || digits == 3) ? point * 10 : point;

   if(ask == 0 || bid == 0)
     {
      Print("OpenLegs: Ask/Bid is 0 — market closed or symbol wrong. Ask=", ask, " Bid=", bid);
      return;
     }

   trade.SetExpertMagicNumber(MagicNumber);
   bool isBuy = (orderType == ORDER_TYPE_BUY);

   // --- Leg 1 — TP1 pips ---
   double price1 = isBuy ? ask : bid;
   double tp1    = isBuy ? price1 + TP1_Pips * pipSize : price1 - TP1_Pips * pipSize;
   double sl1    = isBuy ? price1 - SL_Pips * pipSize  : price1 + SL_Pips * pipSize;
   bool r1 = trade.PositionOpen(Symbol1, orderType, LotSize, price1, sl1, tp1, "Leg1");
   Print("Leg1 result: ", r1, " | retcode: ", trade.ResultRetcode(),
         " | price: ", price1, " | tp: ", tp1, " | sl: ", sl1);

   Sleep(500);

   // --- Leg 2 — TP2 pips ---
   double price2 = isBuy ? SymbolInfoDouble(Symbol1, SYMBOL_ASK) : SymbolInfoDouble(Symbol1, SYMBOL_BID);
   double tp2    = isBuy ? price2 + TP2_Pips * pipSize : price2 - TP2_Pips * pipSize;
   double sl2    = isBuy ? price2 - SL_Pips * pipSize  : price2 + SL_Pips * pipSize;
   bool r2 = trade.PositionOpen(Symbol1, orderType, LotSize, price2, sl2, tp2, "Leg2");
   Print("Leg2 result: ", r2, " | retcode: ", trade.ResultRetcode(),
         " | price: ", price2, " | tp: ", tp2, " | sl: ", sl2);

   Sleep(500);

   // --- Leg 3 — TP3 pips ---
   double price3 = isBuy ? SymbolInfoDouble(Symbol1, SYMBOL_ASK) : SymbolInfoDouble(Symbol1, SYMBOL_BID);
   double tp3    = isBuy ? price3 + TP3_Pips * pipSize : price3 - TP3_Pips * pipSize;
   double sl3    = isBuy ? price3 - SL_Pips * pipSize  : price3 + SL_Pips * pipSize;
   bool r3 = trade.PositionOpen(Symbol1, orderType, LotSize, price3, sl3, tp3, "Leg3");
   Print("Leg3 result: ", r3, " | retcode: ", trade.ResultRetcode(),
         " | price: ", price3, " | tp: ", tp3, " | sl: ", sl3);

   Sleep(500);

   // --- Leg 4 — no TP, runs until manual close ---
   double price4 = isBuy ? SymbolInfoDouble(Symbol1, SYMBOL_ASK) : SymbolInfoDouble(Symbol1, SYMBOL_BID);
   double sl4    = isBuy ? price4 - SL_Pips * pipSize  : price4 + SL_Pips * pipSize;
   bool r4 = trade.PositionOpen(Symbol1, orderType, LotSize, price4, sl4, 0, "Leg4");
   Print("Leg4 result: ", r4, " | retcode: ", trade.ResultRetcode(),
         " | price: ", price4, " | tp: none | sl: ", sl4);
  }

//+------------------------------------------------------------------+
void CloseAllPositions()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(!PositionSelectByTicket(ticket)) continue;
      if(PositionGetString(POSITION_SYMBOL) != Symbol1) continue;
      if((int)PositionGetInteger(POSITION_MAGIC) != MagicNumber) continue;
      bool closed = trade.PositionClose(ticket);
      Print("Close ticket ", ticket, " result: ", closed,
            " | retcode: ", trade.ResultRetcode());
     }
  }

//+------------------------------------------------------------------+
int CountPositions()
  {
   int n = 0;
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong t = PositionGetTicket(i);
      if(PositionSelectByTicket(t) &&
         PositionGetString(POSITION_SYMBOL) == Symbol1 &&
         (int)PositionGetInteger(POSITION_MAGIC) == MagicNumber)
         n++;
     }
   return n;
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
   Print("NodeBridge Multi stopped — reason: ", reason);
  }