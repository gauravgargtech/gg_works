#include <Trade\Trade.mqh>

input string NodeJS_IP   = "172.31.3.112"; // Your Ubuntu EC2 private IP
input int    NodeJS_Port = 3000;            // Your Express port
input string Symbol1     = "AUDUSD.";      // Check exact symbol name in Market Watch
input int    MagicNumber = 12345;
input int    TP1_Pips    = 30;             // Leg1 take profit in pips
input int    TP2_Pips    = 80;             // Leg2 take profit in pips
input int    SL_Pips     = 100;            // Stop loss in pips (all legs)
input int    PollSeconds = 2;              // Poll every 2 seconds

CTrade trade;
datetime lastPoll = 0;

//+------------------------------------------------------------------+
void OnInit()
  {
   Print("=== NodeBridge started ===");
   Print("Polling: ", NodeJS_IP, ":", NodeJS_Port);
   Print("Symbol: ", Symbol1);
   Print("Leg1 — vol: 0.02 | TP: ", TP1_Pips, " pips | SL: ", SL_Pips, " pips");
   Print("Leg2 — vol: 0.03 | TP: ", TP2_Pips, " pips | SL: ", SL_Pips, " pips");
   Print("Leg3 — vol: 0.03 | TP: none        | SL: ", SL_Pips, " pips");

   double ask = SymbolInfoDouble(Symbol1, SYMBOL_ASK);
   double bid = SymbolInfoDouble(Symbol1, SYMBOL_BID);
   Print("Ask: ", ask, "  Bid: ", bid);

   if(ask == 0 || bid == 0)
      Print("WARNING: Ask/Bid is 0 — check Symbol1 matches exactly what MT5 shows in Market Watch");
  }

//+------------------------------------------------------------------+
void OnTick()
  {
   if(TimeCurrent() - lastPoll >= PollSeconds)
     {
      lastPoll = TimeCurrent();
      PollNodeJS();
     }
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
   string response = HttpGet("/mt5/command");
   if(response == "") return;

   string body = ExtractBody(response);
   StringTrimLeft(body);
   StringTrimRight(body);

   if(body == "") return;

   Print("Command body: ", body);
   ProcessCommand(body);
  }

//+------------------------------------------------------------------+
void ProcessCommand(string body)
  {
   if(StringFind(body, "\"action\":\"open\"") >= 0)
     {
      if(CountPositions() > 0)
        {
         Print("Already have open positions — skipping open");
         AckCommand();
         return;
        }
      string dir = (StringFind(body, "\"sell\"") >= 0) ? "sell" : "buy";
      Print("Opening legs direction: ", dir);
      OpenBothLegs(dir);
      AckCommand();
     }
   else if(StringFind(body, "\"action\":\"replace\"") >= 0)
     {
      string dir = (StringFind(body, "\"sell\"") >= 0) ? "sell" : "buy";

      if(CountPositions() > 0)
        {
         Print("Replace — closing existing positions first");
         CloseAllPositions();
         Sleep(1500);
        }

      Print("Replace — opening new legs: ", dir);
      OpenBothLegs(dir);
      AckCommand();
     }
   else if(StringFind(body, "\"action\":\"closeall\"") >= 0)
     {
      Print("Closing all positions");
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
   string response = HttpPost("/mt5/ack", "{}");
   if(response == "")
      Print("AckCommand: no response from server");
   else
      Print("AckCommand sent OK");
  }

//+------------------------------------------------------------------+
void OpenBothLegs(string direction)
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
      Print("OpenBothLegs: Ask/Bid is 0 — market closed or symbol wrong. Ask=", ask, " Bid=", bid);
      return;
     }

   trade.SetExpertMagicNumber(MagicNumber);

   bool isBuy = (orderType == ORDER_TYPE_BUY);

   // --- Leg 1 (0.02 lot) — with TP1 ---
   double price1 = isBuy ? ask : bid;
   double tp1    = isBuy ? price1 + TP1_Pips * pipSize
                         : price1 - TP1_Pips * pipSize;
   double sl1    = isBuy ? price1 - SL_Pips * pipSize
                         : price1 + SL_Pips * pipSize;

   bool r1 = trade.PositionOpen(Symbol1, orderType, 0.02, price1, sl1, tp1, "Leg1");
   Print("Leg1 result: ", r1,
         " | retcode: ", trade.ResultRetcode(),
         " | comment: ", trade.ResultComment(),
         " | price: ", price1,
         " | tp: ", tp1,
         " | sl: ", sl1);

   Sleep(500);

   // --- Leg 2 (0.03 lot) — with TP2 ---
   double price2 = isBuy ? SymbolInfoDouble(Symbol1, SYMBOL_ASK)
                         : SymbolInfoDouble(Symbol1, SYMBOL_BID);
   double tp2    = isBuy ? price2 + TP2_Pips * pipSize
                         : price2 - TP2_Pips * pipSize;
   double sl2    = isBuy ? price2 - SL_Pips * pipSize
                         : price2 + SL_Pips * pipSize;

   bool r2 = trade.PositionOpen(Symbol1, orderType, 0.03, price2, sl2, tp2, "Leg2");
   Print("Leg2 result: ", r2,
         " | retcode: ", trade.ResultRetcode(),
         " | comment: ", trade.ResultComment(),
         " | price: ", price2,
         " | tp: ", tp2,
         " | sl: ", sl2);

   Sleep(500);

   // --- Leg 3 (0.03 lot) — NO TP, same SL ---
   double price3 = isBuy ? SymbolInfoDouble(Symbol1, SYMBOL_ASK)
                         : SymbolInfoDouble(Symbol1, SYMBOL_BID);
   double sl3    = isBuy ? price3 - SL_Pips * pipSize
                         : price3 + SL_Pips * pipSize;

   bool r3 = trade.PositionOpen(Symbol1, orderType, 0.03, price3, sl3, 0, "Leg3");
   Print("Leg3 result: ", r3,
         " | retcode: ", trade.ResultRetcode(),
         " | comment: ", trade.ResultComment(),
         " | price: ", price3,
         " | tp: none (0)",
         " | sl: ", sl3);
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
            " | retcode: ", trade.ResultRetcode(),
            " | comment: ", trade.ResultComment());
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
   Print("NodeBridge stopped — reason: ", reason);
  }